/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <functional>
#include <memory>
#include <vector>
#include "secerr.h"
#include "ssl.h"
#include "sslerr.h"
#include "sslproto.h"

extern "C" {
// This is not something that should make you happy.
#include "libssl_internals.h"
}

#include "gtest_utils.h"
#include "scoped_ptrs.h"
#include "tls_connect.h"
#include "tls_filter.h"
#include "tls_parser.h"

namespace nss_test {

TEST_P(TlsConnectGeneric, SetupOnly) {}

TEST_P(TlsConnectGeneric, Connect) {
  SetExpectedVersion(std::get<1>(GetParam()));
  Connect();
  CheckKeys();
}

TEST_P(TlsConnectGeneric, ConnectEcdsa) {
  SetExpectedVersion(std::get<1>(GetParam()));
  Reset(TlsAgent::kServerEcdsa256);
  Connect();
  CheckKeys(ssl_kea_ecdh, ssl_auth_ecdsa);
}

TEST_P(TlsConnectGeneric, CipherSuiteMismatch) {
  EnsureTlsSetup();
  if (version_ >= SSL_LIBRARY_VERSION_TLS_1_3) {
    client_->EnableSingleCipher(TLS_AES_128_GCM_SHA256);
    server_->EnableSingleCipher(TLS_AES_256_GCM_SHA384);
  } else {
    client_->EnableSingleCipher(TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA);
    server_->EnableSingleCipher(TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA);
  }
  ConnectExpectAlert(server_, kTlsAlertHandshakeFailure);
  client_->CheckErrorCode(SSL_ERROR_NO_CYPHER_OVERLAP);
  server_->CheckErrorCode(SSL_ERROR_NO_CYPHER_OVERLAP);
}

class TlsAlertRecorder : public TlsRecordFilter {
 public:
  TlsAlertRecorder(const std::shared_ptr<TlsAgent>& a)
      : TlsRecordFilter(a), level_(255), description_(255) {}

  PacketFilter::Action FilterRecord(const TlsRecordHeader& header,
                                    const DataBuffer& input,
                                    DataBuffer* output) override {
    if (level_ != 255) {  // Already captured.
      return KEEP;
    }
    if (header.content_type() != kTlsAlertType) {
      return KEEP;
    }

    std::cerr << "Alert: " << input << std::endl;

    TlsParser parser(input);
    EXPECT_TRUE(parser.Read(&level_));
    EXPECT_TRUE(parser.Read(&description_));
    return KEEP;
  }

  uint8_t level() const { return level_; }
  uint8_t description() const { return description_; }

 private:
  uint8_t level_;
  uint8_t description_;
};

class HelloTruncator : public TlsHandshakeFilter {
 public:
  HelloTruncator(const std::shared_ptr<TlsAgent>& a)
      : TlsHandshakeFilter(
            a, {kTlsHandshakeClientHello, kTlsHandshakeServerHello}) {}
  PacketFilter::Action FilterHandshake(const HandshakeHeader& header,
                                       const DataBuffer& input,
                                       DataBuffer* output) override {
    output->Assign(input.data(), input.len() - 1);
    return CHANGE;
  }
};

// Verify that when NSS reports that an alert is sent, it is actually sent.
TEST_P(TlsConnectGeneric, CaptureAlertServer) {
  MakeTlsFilter<HelloTruncator>(client_);
  auto alert_recorder = MakeTlsFilter<TlsAlertRecorder>(server_);

  ConnectExpectAlert(server_, kTlsAlertDecodeError);
  EXPECT_EQ(kTlsAlertFatal, alert_recorder->level());
  EXPECT_EQ(kTlsAlertDecodeError, alert_recorder->description());
}

TEST_P(TlsConnectGenericPre13, CaptureAlertClient) {
  MakeTlsFilter<HelloTruncator>(server_);
  auto alert_recorder = MakeTlsFilter<TlsAlertRecorder>(client_);

  ConnectExpectAlert(client_, kTlsAlertDecodeError);
  EXPECT_EQ(kTlsAlertFatal, alert_recorder->level());
  EXPECT_EQ(kTlsAlertDecodeError, alert_recorder->description());
}

// In TLS 1.3, the server can't read the client alert.
TEST_P(TlsConnectTls13, CaptureAlertClient) {
  MakeTlsFilter<HelloTruncator>(server_);
  auto alert_recorder = MakeTlsFilter<TlsAlertRecorder>(client_);

  StartConnect();

  client_->Handshake();
  client_->ExpectSendAlert(kTlsAlertDecodeError);
  server_->Handshake();
  client_->Handshake();
  if (variant_ == ssl_variant_stream) {
    // DTLS just drops the alert it can't decrypt.
    server_->ExpectSendAlert(kTlsAlertBadRecordMac);
  }
  server_->Handshake();
  EXPECT_EQ(kTlsAlertFatal, alert_recorder->level());
  EXPECT_EQ(kTlsAlertDecodeError, alert_recorder->description());
}

TEST_P(TlsConnectGenericPre13, ConnectFalseStart) {
  client_->EnableFalseStart();
  Connect();
  SendReceive();
}

TEST_P(TlsConnectGeneric, ConnectAlpn) {
  EnableAlpn();
  Connect();
  CheckAlpn("a");
}

TEST_P(TlsConnectGeneric, ConnectAlpnClone) {
  EnsureModelSockets();
  client_model_->EnableAlpn(alpn_dummy_val_, sizeof(alpn_dummy_val_));
  server_model_->EnableAlpn(alpn_dummy_val_, sizeof(alpn_dummy_val_));
  Connect();
  CheckAlpn("a");
}

TEST_P(TlsConnectDatagram, ConnectSrtp) {
  EnableSrtp();
  Connect();
  CheckSrtp();
  SendReceive();
}

TEST_P(TlsConnectGeneric, ConnectSendReceive) {
  Connect();
  SendReceive();
}

class SaveTlsRecord : public TlsRecordFilter {
 public:
  SaveTlsRecord(const std::shared_ptr<TlsAgent>& a, size_t index)
      : TlsRecordFilter(a), index_(index), count_(0), contents_() {}

  const DataBuffer& contents() const { return contents_; }

 protected:
  PacketFilter::Action FilterRecord(const TlsRecordHeader& header,
                                    const DataBuffer& data,
                                    DataBuffer* changed) override {
    if (count_++ == index_) {
      contents_ = data;
    }
    return KEEP;
  }

 private:
  const size_t index_;
  size_t count_;
  DataBuffer contents_;
};

// Check that decrypting filters work and can read any record.
// This test (currently) only works in TLS 1.3 where we can decrypt.
TEST_F(TlsConnectStreamTls13, DecryptRecordClient) {
  EnsureTlsSetup();
  // 0 = ClientHello, 1 = Finished, 2 = SendReceive, 3 = SendBuffer
  auto saved = MakeTlsFilter<SaveTlsRecord>(client_, 3);
  saved->EnableDecryption();
  Connect();
  SendReceive();

  static const uint8_t data[] = {0xde, 0xad, 0xdc};
  DataBuffer buf(data, sizeof(data));
  client_->SendBuffer(buf);
  EXPECT_EQ(buf, saved->contents());
}

TEST_F(TlsConnectStreamTls13, DecryptRecordServer) {
  EnsureTlsSetup();
  // Disable tickets so that we are sure to not get NewSessionTicket.
  EXPECT_EQ(SECSuccess, SSL_OptionSet(server_->ssl_fd(),
                                      SSL_ENABLE_SESSION_TICKETS, PR_FALSE));
  // 0 = ServerHello, 1 = other handshake, 2 = SendReceive, 3 = SendBuffer
  auto saved = MakeTlsFilter<SaveTlsRecord>(server_, 3);
  saved->EnableDecryption();
  Connect();
  SendReceive();

  static const uint8_t data[] = {0xde, 0xad, 0xd5};
  DataBuffer buf(data, sizeof(data));
  server_->SendBuffer(buf);
  EXPECT_EQ(buf, saved->contents());
}

class DropTlsRecord : public TlsRecordFilter {
 public:
  DropTlsRecord(const std::shared_ptr<TlsAgent>& a, size_t index)
      : TlsRecordFilter(a), index_(index), count_(0) {}

 protected:
  PacketFilter::Action FilterRecord(const TlsRecordHeader& header,
                                    const DataBuffer& data,
                                    DataBuffer* changed) override {
    if (count_++ == index_) {
      return DROP;
    }
    return KEEP;
  }

 private:
  const size_t index_;
  size_t count_;
};

// Test that decrypting filters work correctly and are able to drop records.
TEST_F(TlsConnectStreamTls13, DropRecordServer) {
  EnsureTlsSetup();
  // Disable session tickets so that the server doesn't send an extra record.
  EXPECT_EQ(SECSuccess, SSL_OptionSet(server_->ssl_fd(),
                                      SSL_ENABLE_SESSION_TICKETS, PR_FALSE));

  // 0 = ServerHello, 1 = other handshake, 2 = first write
  auto filter = MakeTlsFilter<DropTlsRecord>(server_, 2);
  filter->EnableDecryption();
  Connect();
  server_->SendData(23, 23);  // This should be dropped, so it won't be counted.
  server_->ResetSentBytes();
  SendReceive();
}

TEST_F(TlsConnectStreamTls13, DropRecordClient) {
  EnsureTlsSetup();
  // 0 = ClientHello, 1 = Finished, 2 = first write
  auto filter = MakeTlsFilter<DropTlsRecord>(client_, 2);
  filter->EnableDecryption();
  Connect();
  client_->SendData(26, 26);  // This should be dropped, so it won't be counted.
  client_->ResetSentBytes();
  SendReceive();
}

// The next two tests takes advantage of the fact that we
// automatically read the first 1024 bytes, so if
// we provide 1200 bytes, they overrun the read buffer
// provided by the calling test.

// DTLS should return an error.
TEST_P(TlsConnectDatagram, ShortRead) {
  Connect();
  client_->ExpectReadWriteError();
  server_->SendData(50, 50);
  client_->ReadBytes(20);
  EXPECT_EQ(0U, client_->received_bytes());
  EXPECT_EQ(SSL_ERROR_RX_SHORT_DTLS_READ, PORT_GetError());

  // Now send and receive another packet.
  server_->ResetSentBytes();  // Reset the counter.
  SendReceive();
}

// TLS should get the write in two chunks.
TEST_P(TlsConnectStream, ShortRead) {
  // This test behaves oddly with TLS 1.0 because of 1/n+1 splitting,
  // so skip in that case.
  if (version_ < SSL_LIBRARY_VERSION_TLS_1_1) return;

  Connect();
  server_->SendData(50, 50);
  // Read the first tranche.
  client_->ReadBytes(20);
  ASSERT_EQ(20U, client_->received_bytes());
  // The second tranche should now immediately be available.
  client_->ReadBytes();
  ASSERT_EQ(50U, client_->received_bytes());
}

// We enable compression via the API but it's disabled internally,
// so we should never get it.
TEST_P(TlsConnectGeneric, ConnectWithCompressionEnabled) {
  EnsureTlsSetup();
  client_->SetOption(SSL_ENABLE_DEFLATE, PR_TRUE);
  server_->SetOption(SSL_ENABLE_DEFLATE, PR_TRUE);
  Connect();
  EXPECT_FALSE(client_->is_compressed());
  SendReceive();
}

class TlsHolddownTest : public TlsConnectDatagram {
 protected:
  // This causes all timers to run to completion.  It advances the clock and
  // handshakes on both peers until both peers have no more timers pending,
  // which should happen at the end of a handshake.  This is necessary to ensure
  // that the relatively long holddown timer expires, but that any other timers
  // also expire and run correctly.
  void RunAllTimersDown() {
    while (true) {
      PRIntervalTime time;
      SECStatus rv = DTLS_GetHandshakeTimeout(client_->ssl_fd(), &time);
      if (rv != SECSuccess) {
        rv = DTLS_GetHandshakeTimeout(server_->ssl_fd(), &time);
        if (rv != SECSuccess) {
          break;  // Neither peer has an outstanding timer.
        }
      }

      if (g_ssl_gtest_verbose) {
        std::cerr << "Shifting timers" << std::endl;
      }
      ShiftDtlsTimers();
      Handshake();
    }
  }
};

TEST_P(TlsHolddownTest, TestDtlsHolddownExpiry) {
  Connect();
  std::cerr << "Expiring holddown timer" << std::endl;
  RunAllTimersDown();
  SendReceive();
  if (version_ >= SSL_LIBRARY_VERSION_TLS_1_3) {
    // One for send, one for receive.
    EXPECT_EQ(2, SSLInt_CountCipherSpecs(client_->ssl_fd()));
  }
}

TEST_P(TlsHolddownTest, TestDtlsHolddownExpiryResumption) {
  ConfigureSessionCache(RESUME_BOTH, RESUME_TICKET);
  Connect();
  SendReceive();

  Reset();
  ConfigureSessionCache(RESUME_BOTH, RESUME_TICKET);
  ExpectResumption(RESUME_TICKET);
  Connect();
  RunAllTimersDown();
  SendReceive();
  // One for send, one for receive.
  EXPECT_EQ(2, SSLInt_CountCipherSpecs(client_->ssl_fd()));
}

class TlsPreCCSHeaderInjector : public TlsRecordFilter {
 public:
  TlsPreCCSHeaderInjector(const std::shared_ptr<TlsAgent>& a)
      : TlsRecordFilter(a) {}
  virtual PacketFilter::Action FilterRecord(
      const TlsRecordHeader& record_header, const DataBuffer& input,
      size_t* offset, DataBuffer* output) override {
    if (record_header.content_type() != kTlsChangeCipherSpecType) return KEEP;

    std::cerr << "Injecting Finished header before CCS\n";
    const uint8_t hhdr[] = {kTlsHandshakeFinished, 0x00, 0x00, 0x0c};
    DataBuffer hhdr_buf(hhdr, sizeof(hhdr));
    TlsRecordHeader nhdr(record_header.variant(), record_header.version(),
                         kTlsHandshakeType, 0);
    *offset = nhdr.Write(output, *offset, hhdr_buf);
    *offset = record_header.Write(output, *offset, input);
    return CHANGE;
  }
};

TEST_P(TlsConnectStreamPre13, ClientFinishedHeaderBeforeCCS) {
  MakeTlsFilter<TlsPreCCSHeaderInjector>(client_);
  ConnectExpectAlert(server_, kTlsAlertUnexpectedMessage);
  client_->CheckErrorCode(SSL_ERROR_HANDSHAKE_UNEXPECTED_ALERT);
  server_->CheckErrorCode(SSL_ERROR_RX_UNEXPECTED_CHANGE_CIPHER);
}

TEST_P(TlsConnectStreamPre13, ServerFinishedHeaderBeforeCCS) {
  MakeTlsFilter<TlsPreCCSHeaderInjector>(server_);
  StartConnect();
  ExpectAlert(client_, kTlsAlertUnexpectedMessage);
  Handshake();
  EXPECT_EQ(TlsAgent::STATE_ERROR, client_->state());
  client_->CheckErrorCode(SSL_ERROR_RX_UNEXPECTED_CHANGE_CIPHER);
  EXPECT_EQ(TlsAgent::STATE_CONNECTED, server_->state());
  server_->Handshake();  // Make sure alert is consumed.
}

TEST_P(TlsConnectTls13, UnknownAlert) {
  Connect();
  server_->ExpectSendAlert(0xff, kTlsAlertWarning);
  client_->ExpectReceiveAlert(0xff, kTlsAlertWarning);
  SSLInt_SendAlert(server_->ssl_fd(), kTlsAlertWarning,
                   0xff);  // Unknown value.
  client_->ExpectReadWriteError();
  client_->WaitForErrorCode(SSL_ERROR_RX_UNKNOWN_ALERT, 2000);
}

TEST_P(TlsConnectTls13, AlertWrongLevel) {
  Connect();
  server_->ExpectSendAlert(kTlsAlertUnexpectedMessage, kTlsAlertWarning);
  client_->ExpectReceiveAlert(kTlsAlertUnexpectedMessage, kTlsAlertWarning);
  SSLInt_SendAlert(server_->ssl_fd(), kTlsAlertWarning,
                   kTlsAlertUnexpectedMessage);
  client_->ExpectReadWriteError();
  client_->WaitForErrorCode(SSL_ERROR_HANDSHAKE_UNEXPECTED_ALERT, 2000);
}

TEST_F(TlsConnectStreamTls13, Tls13FailedWriteSecondFlight) {
  EnsureTlsSetup();
  StartConnect();
  client_->Handshake();
  server_->Handshake();  // Send first flight.
  client_->adapter()->SetWriteError(PR_IO_ERROR);
  client_->Handshake();  // This will get an error, but shouldn't crash.
  client_->CheckErrorCode(SSL_ERROR_SOCKET_WRITE_FAILURE);
}

TEST_P(TlsConnectDatagram, BlockedWrite) {
  Connect();

  // Mark the socket as blocked.
  client_->adapter()->SetWriteError(PR_WOULD_BLOCK_ERROR);
  static const uint8_t data[] = {1, 2, 3};
  int32_t rv = PR_Write(client_->ssl_fd(), data, sizeof(data));
  EXPECT_GT(0, rv);
  EXPECT_EQ(PR_WOULD_BLOCK_ERROR, PORT_GetError());

  // Remove the write error and though the previous write failed, future reads
  // and writes should just work as if it never happened.
  client_->adapter()->SetWriteError(0);
  SendReceive();
}

TEST_F(TlsConnectTest, ConnectSSLv3) {
  ConfigureVersion(SSL_LIBRARY_VERSION_3_0);
  EnableOnlyStaticRsaCiphers();
  Connect();
  CheckKeys(ssl_kea_rsa, ssl_grp_none, ssl_auth_rsa_decrypt, ssl_sig_none);
}

TEST_F(TlsConnectTest, ConnectSSLv3ClientAuth) {
  ConfigureVersion(SSL_LIBRARY_VERSION_3_0);
  EnableOnlyStaticRsaCiphers();
  client_->SetupClientAuth();
  server_->RequestClientAuth(true);
  Connect();
  CheckKeys(ssl_kea_rsa, ssl_grp_none, ssl_auth_rsa_decrypt, ssl_sig_none);
}

static size_t ExpectedCbcLen(size_t in, size_t hmac = 20, size_t block = 16) {
  // MAC-then-Encrypt expansion formula:
  return ((in + hmac + (block - 1)) / block) * block;
}

TEST_F(TlsConnectTest, OneNRecordSplitting) {
  ConfigureVersion(SSL_LIBRARY_VERSION_TLS_1_0);
  EnsureTlsSetup();
  ConnectWithCipherSuite(TLS_RSA_WITH_AES_128_CBC_SHA);
  auto records = MakeTlsFilter<TlsRecordRecorder>(server_);
  // This should be split into 1, 16384 and 20.
  DataBuffer big_buffer;
  big_buffer.Allocate(1 + 16384 + 20);
  server_->SendBuffer(big_buffer);
  ASSERT_EQ(3U, records->count());
  EXPECT_EQ(ExpectedCbcLen(1), records->record(0).buffer.len());
  EXPECT_EQ(ExpectedCbcLen(16384), records->record(1).buffer.len());
  EXPECT_EQ(ExpectedCbcLen(20), records->record(2).buffer.len());
}

INSTANTIATE_TEST_CASE_P(
    GenericStream, TlsConnectGeneric,
    ::testing::Combine(TlsConnectTestBase::kTlsVariantsStream,
                       TlsConnectTestBase::kTlsVAll));
INSTANTIATE_TEST_CASE_P(
    GenericDatagram, TlsConnectGeneric,
    ::testing::Combine(TlsConnectTestBase::kTlsVariantsDatagram,
                       TlsConnectTestBase::kTlsV11Plus));

INSTANTIATE_TEST_CASE_P(StreamOnly, TlsConnectStream,
                        TlsConnectTestBase::kTlsVAll);
INSTANTIATE_TEST_CASE_P(DatagramOnly, TlsConnectDatagram,
                        TlsConnectTestBase::kTlsV11Plus);
INSTANTIATE_TEST_CASE_P(DatagramHolddown, TlsHolddownTest,
                        TlsConnectTestBase::kTlsV11Plus);

INSTANTIATE_TEST_CASE_P(
    Pre12Stream, TlsConnectPre12,
    ::testing::Combine(TlsConnectTestBase::kTlsVariantsStream,
                       TlsConnectTestBase::kTlsV10V11));
INSTANTIATE_TEST_CASE_P(
    Pre12Datagram, TlsConnectPre12,
    ::testing::Combine(TlsConnectTestBase::kTlsVariantsDatagram,
                       TlsConnectTestBase::kTlsV11));

INSTANTIATE_TEST_CASE_P(Version12Only, TlsConnectTls12,
                        TlsConnectTestBase::kTlsVariantsAll);
#ifndef NSS_DISABLE_TLS_1_3
INSTANTIATE_TEST_CASE_P(Version13Only, TlsConnectTls13,
                        TlsConnectTestBase::kTlsVariantsAll);
#endif

INSTANTIATE_TEST_CASE_P(
    Pre13Stream, TlsConnectGenericPre13,
    ::testing::Combine(TlsConnectTestBase::kTlsVariantsStream,
                       TlsConnectTestBase::kTlsV10ToV12));
INSTANTIATE_TEST_CASE_P(
    Pre13Datagram, TlsConnectGenericPre13,
    ::testing::Combine(TlsConnectTestBase::kTlsVariantsDatagram,
                       TlsConnectTestBase::kTlsV11V12));
INSTANTIATE_TEST_CASE_P(Pre13StreamOnly, TlsConnectStreamPre13,
                        TlsConnectTestBase::kTlsV10ToV12);

INSTANTIATE_TEST_CASE_P(Version12Plus, TlsConnectTls12Plus,
                        ::testing::Combine(TlsConnectTestBase::kTlsVariantsAll,
                                           TlsConnectTestBase::kTlsV12Plus));

INSTANTIATE_TEST_CASE_P(
    GenericStream, TlsConnectGenericResumption,
    ::testing::Combine(TlsConnectTestBase::kTlsVariantsStream,
                       TlsConnectTestBase::kTlsVAll,
                       ::testing::Values(true, false)));
INSTANTIATE_TEST_CASE_P(
    GenericDatagram, TlsConnectGenericResumption,
    ::testing::Combine(TlsConnectTestBase::kTlsVariantsDatagram,
                       TlsConnectTestBase::kTlsV11Plus,
                       ::testing::Values(true, false)));

INSTANTIATE_TEST_CASE_P(
    GenericStream, TlsConnectGenericResumptionToken,
    ::testing::Combine(TlsConnectTestBase::kTlsVariantsStream,
                       TlsConnectTestBase::kTlsVAll));
INSTANTIATE_TEST_CASE_P(
    GenericDatagram, TlsConnectGenericResumptionToken,
    ::testing::Combine(TlsConnectTestBase::kTlsVariantsDatagram,
                       TlsConnectTestBase::kTlsV11Plus));

INSTANTIATE_TEST_CASE_P(GenericDatagram, TlsConnectTls13ResumptionToken,
                        TlsConnectTestBase::kTlsVariantsAll);

}  // namespace nss_test
