/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* global Pipe, ScriptableInputStream, uneval */

// TODO: Get rid of this code once the marionette server loads transport.js as
// an SDK module (see bug 1000814)
(function(factory) {
  if (this.module && module.id.includes("transport")) {
    // require
    factory.call(this, require, exports);
  } else if (this.require) {
    // loadSubScript
    factory.call(this, require, this);
  } else {
    // Cu.import
    const { require } = ChromeUtils.import("resource://devtools/shared/Loader.jsm", {});
    factory.call(this, require, this);
  }
}).call(this, function(require, exports) {
  const { Cc, Cr, CC } = require("chrome");
  const DevToolsUtils = require("devtools/shared/DevToolsUtils");
  const { dumpn, dumpv } = DevToolsUtils;
  const flags = require("devtools/shared/flags");
  const StreamUtils = require("devtools/shared/transport/stream-utils");
  const { Packet, JSONPacket, BulkPacket } =
  require("devtools/shared/transport/packets");
  const promise = require("promise");
  const defer = require("devtools/shared/defer");
  const EventEmitter = require("devtools/shared/event-emitter");

  DevToolsUtils.defineLazyGetter(this, "Pipe", () => {
    return CC("@mozilla.org/pipe;1", "nsIPipe", "init");
  });

  DevToolsUtils.defineLazyGetter(this, "ScriptableInputStream", () => {
    return CC("@mozilla.org/scriptableinputstream;1",
            "nsIScriptableInputStream", "init");
  });

  const PACKET_HEADER_MAX = 200;

  /**
   * An adapter that handles data transfers between the debugger client and
   * server. It can work with both nsIPipe and nsIServerSocket transports so
   * long as the properly created input and output streams are specified.
   * (However, for intra-process connections, LocalDebuggerTransport, below,
   * is more efficient than using an nsIPipe pair with DebuggerTransport.)
   *
   * @param input nsIAsyncInputStream
   *        The input stream.
   * @param output nsIAsyncOutputStream
   *        The output stream.
   *
   * Given a DebuggerTransport instance dt:
   * 1) Set dt.hooks to a packet handler object (described below).
   * 2) Call dt.ready() to begin watching for input packets.
   * 3) Call dt.send() / dt.startBulkSend() to send packets.
   * 4) Call dt.close() to close the connection, and disengage from the event
   *    loop.
   *
   * A packet handler is an object with the following methods:
   *
   * - onPacket(packet) - called when we have received a complete packet.
   *   |packet| is the parsed form of the packet --- a JavaScript value, not
   *   a JSON-syntax string.
   *
   * - onBulkPacket(packet) - called when we have switched to bulk packet
   *   receiving mode. |packet| is an object containing:
   *   * actor:  Name of actor that will receive the packet
   *   * type:   Name of actor's method that should be called on receipt
   *   * length: Size of the data to be read
   *   * stream: This input stream should only be used directly if you can ensure
   *             that you will read exactly |length| bytes and will not close the
   *             stream when reading is complete
   *   * done:   If you use the stream directly (instead of |copyTo| below), you
   *             must signal completion by resolving / rejecting this deferred.
   *             If it's rejected, the transport will be closed.  If an Error is
   *             supplied as a rejection value, it will be logged via |dumpn|.
   *             If you do use |copyTo|, resolving is taken care of for you when
   *             copying completes.
   *   * copyTo: A helper function for getting your data out of the stream that
   *             meets the stream handling requirements above, and has the
   *             following signature:
   *     @param  output nsIAsyncOutputStream
   *             The stream to copy to.
   *     @return Promise
   *             The promise is resolved when copying completes or rejected if any
   *             (unexpected) errors occur.
   *             This object also emits "progress" events for each chunk that is
   *             copied.  See stream-utils.js.
   *
   * - onClosed(reason) - called when the connection is closed. |reason| is
   *   an optional nsresult or object, typically passed when the transport is
   *   closed due to some error in a underlying stream.
   *
   * See ./packets.js and the Remote Debugging Protocol specification for more
   * details on the format of these packets.
   */
  function DebuggerTransport(input, output) {
    EventEmitter.decorate(this);

    this._input = input;
    this._scriptableInput = new ScriptableInputStream(input);
    this._output = output;

    // The current incoming (possibly partial) header, which will determine which
    // type of Packet |_incoming| below will become.
    this._incomingHeader = "";
    // The current incoming Packet object
    this._incoming = null;
    // A queue of outgoing Packet objects
    this._outgoing = [];

    this.hooks = null;
    this.active = false;

    this._incomingEnabled = true;
    this._outgoingEnabled = true;

    this.close = this.close.bind(this);
  }

  DebuggerTransport.prototype = {
    /**
     * Transmit an object as a JSON packet.
     *
     * This method returns immediately, without waiting for the entire
     * packet to be transmitted, registering event handlers as needed to
     * transmit the entire packet. Packets are transmitted in the order
     * they are passed to this method.
     */
    send: function(object) {
      this.emit("send", object);

      let packet = new JSONPacket(this);
      packet.object = object;
      this._outgoing.push(packet);
      this._flushOutgoing();
    },

    /**
     * Transmit streaming data via a bulk packet.
     *
     * This method initiates the bulk send process by queuing up the header data.
     * The caller receives eventual access to a stream for writing.
     *
     * N.B.: Do *not* attempt to close the stream handed to you, as it will
     * continue to be used by this transport afterwards.  Most users should
     * instead use the provided |copyFrom| function instead.
     *
     * @param header Object
     *        This is modeled after the format of JSON packets above, but does not
     *        actually contain the data, but is instead just a routing header:
     *          * actor:  Name of actor that will receive the packet
     *          * type:   Name of actor's method that should be called on receipt
     *          * length: Size of the data to be sent
     * @return Promise
     *         The promise will be resolved when you are allowed to write to the
     *         stream with an object containing:
     *           * stream:   This output stream should only be used directly if
     *                       you can ensure that you will write exactly |length|
     *                       bytes and will not close the stream when writing is
     *                       complete
     *           * done:     If you use the stream directly (instead of |copyFrom|
     *                       below), you must signal completion by resolving /
     *                       rejecting this deferred.  If it's rejected, the
     *                       transport will be closed.  If an Error is supplied as
     *                       a rejection value, it will be logged via |dumpn|.  If
     *                       you do use |copyFrom|, resolving is taken care of for
     *                       you when copying completes.
     *           * copyFrom: A helper function for getting your data onto the
     *                       stream that meets the stream handling requirements
     *                       above, and has the following signature:
     *             @param  input nsIAsyncInputStream
     *                     The stream to copy from.
     *             @return Promise
     *                     The promise is resolved when copying completes or
     *                     rejected if any (unexpected) errors occur.
     *                     This object also emits "progress" events for each chunk
     *                     that is copied.  See stream-utils.js.
     */
    startBulkSend: function(header) {
      this.emit("startbulksend", header);

      let packet = new BulkPacket(this);
      packet.header = header;
      this._outgoing.push(packet);
      this._flushOutgoing();
      return packet.streamReadyForWriting;
    },

    /**
     * Close the transport.
     * @param reason nsresult / object (optional)
     *        The status code or error message that corresponds to the reason for
     *        closing the transport (likely because a stream closed or failed).
     */
    close: function(reason) {
      this.emit("close", reason);

      this.active = false;
      this._input.close();
      this._scriptableInput.close();
      this._output.close();
      this._destroyIncoming();
      this._destroyAllOutgoing();
      if (this.hooks) {
        this.hooks.onClosed(reason);
        this.hooks = null;
      }
      if (reason) {
        dumpn("Transport closed: " + DevToolsUtils.safeErrorString(reason));
      } else {
        dumpn("Transport closed.");
      }
    },

    /**
     * The currently outgoing packet (at the top of the queue).
     */
    get _currentOutgoing() {
      return this._outgoing[0];
    },

    /**
     * Flush data to the outgoing stream.  Waits until the output stream notifies
     * us that it is ready to be written to (via onOutputStreamReady).
     */
    _flushOutgoing: function() {
      if (!this._outgoingEnabled || this._outgoing.length === 0) {
        return;
      }

      // If the top of the packet queue has nothing more to send, remove it.
      if (this._currentOutgoing.done) {
        this._finishCurrentOutgoing();
      }

      if (this._outgoing.length > 0) {
        let threadManager = Cc["@mozilla.org/thread-manager;1"].getService();
        this._output.asyncWait(this, 0, 0, threadManager.currentThread);
      }
    },

    /**
     * Pause this transport's attempts to write to the output stream.  This is
     * used when we've temporarily handed off our output stream for writing bulk
     * data.
     */
    pauseOutgoing: function() {
      this._outgoingEnabled = false;
    },

    /**
     * Resume this transport's attempts to write to the output stream.
     */
    resumeOutgoing: function() {
      this._outgoingEnabled = true;
      this._flushOutgoing();
    },

    // nsIOutputStreamCallback
    /**
     * This is called when the output stream is ready for more data to be written.
     * The current outgoing packet will attempt to write some amount of data, but
     * may not complete.
     */
    onOutputStreamReady: DevToolsUtils.makeInfallible(function(stream) {
      if (!this._outgoingEnabled || this._outgoing.length === 0) {
        return;
      }

      try {
        this._currentOutgoing.write(stream);
      } catch (e) {
        if (e.result != Cr.NS_BASE_STREAM_WOULD_BLOCK) {
          this.close(e.result);
          return;
        }
        throw e;
      }

      this._flushOutgoing();
    }, "DebuggerTransport.prototype.onOutputStreamReady"),

    /**
     * Remove the current outgoing packet from the queue upon completion.
     */
    _finishCurrentOutgoing: function() {
      if (this._currentOutgoing) {
        this._currentOutgoing.destroy();
        this._outgoing.shift();
      }
    },

    /**
     * Clear the entire outgoing queue.
     */
    _destroyAllOutgoing: function() {
      for (let packet of this._outgoing) {
        packet.destroy();
      }
      this._outgoing = [];
    },

    /**
     * Initialize the input stream for reading. Once this method has been called,
     * we watch for packets on the input stream, and pass them to the appropriate
     * handlers via this.hooks.
     */
    ready: function() {
      this.active = true;
      this._waitForIncoming();
    },

    /**
     * Asks the input stream to notify us (via onInputStreamReady) when it is
     * ready for reading.
     */
    _waitForIncoming: function() {
      if (this._incomingEnabled) {
        let threadManager = Cc["@mozilla.org/thread-manager;1"].getService();
        this._input.asyncWait(this, 0, 0, threadManager.currentThread);
      }
    },

    /**
     * Pause this transport's attempts to read from the input stream.  This is
     * used when we've temporarily handed off our input stream for reading bulk
     * data.
     */
    pauseIncoming: function() {
      this._incomingEnabled = false;
    },

    /**
     * Resume this transport's attempts to read from the input stream.
     */
    resumeIncoming: function() {
      this._incomingEnabled = true;
      this._flushIncoming();
      this._waitForIncoming();
    },

    // nsIInputStreamCallback
    /**
     * Called when the stream is either readable or closed.
     */
    onInputStreamReady: DevToolsUtils.makeInfallible(function(stream) {
      try {
        while (stream.available() && this._incomingEnabled &&
               this._processIncoming(stream, stream.available())) {
           // Loop until there is nothing more to process
        }
        this._waitForIncoming();
      } catch (e) {
        if (e.result != Cr.NS_BASE_STREAM_WOULD_BLOCK) {
          this.close(e.result);
        } else {
          throw e;
        }
      }
    }, "DebuggerTransport.prototype.onInputStreamReady"),

    /**
     * Process the incoming data.  Will create a new currently incoming Packet if
     * needed.  Tells the incoming Packet to read as much data as it can, but
     * reading may not complete.  The Packet signals that its data is ready for
     * delivery by calling one of this transport's _on*Ready methods (see
     * ./packets.js and the _on*Ready methods below).
     * @return boolean
     *         Whether incoming stream processing should continue for any
     *         remaining data.
     */
    _processIncoming: function(stream, count) {
      dumpv("Data available: " + count);

      if (!count) {
        dumpv("Nothing to read, skipping");
        return false;
      }

      try {
        if (!this._incoming) {
          dumpv("Creating a new packet from incoming");

          if (!this._readHeader(stream)) {
            // Not enough data to read packet type
            return false;
          }

          // Attempt to create a new Packet by trying to parse each possible
          // header pattern.
          this._incoming = Packet.fromHeader(this._incomingHeader, this);
          if (!this._incoming) {
            throw new Error("No packet types for header: " +
                          this._incomingHeader);
          }
        }

        if (!this._incoming.done) {
          // We have an incomplete packet, keep reading it.
          dumpv("Existing packet incomplete, keep reading");
          this._incoming.read(stream, this._scriptableInput);
        }
      } catch (e) {
        let msg = "Error reading incoming packet: (" + e + " - " + e.stack + ")";
        dumpn(msg);

        // Now in an invalid state, shut down the transport.
        this.close();
        return false;
      }

      if (!this._incoming.done) {
        // Still not complete, we'll wait for more data.
        dumpv("Packet not done, wait for more");
        return true;
      }

      // Ready for next packet
      this._flushIncoming();
      return true;
    },

    /**
     * Read as far as we can into the incoming data, attempting to build up a
     * complete packet header (which terminates with ":").  We'll only read up to
     * PACKET_HEADER_MAX characters.
     * @return boolean
     *         True if we now have a complete header.
     */
    _readHeader: function() {
      let amountToRead = PACKET_HEADER_MAX - this._incomingHeader.length;
      this._incomingHeader +=
      StreamUtils.delimitedRead(this._scriptableInput, ":", amountToRead);
      if (flags.wantVerbose) {
        dumpv("Header read: " + this._incomingHeader);
      }

      if (this._incomingHeader.endsWith(":")) {
        if (flags.wantVerbose) {
          dumpv("Found packet header successfully: " + this._incomingHeader);
        }
        return true;
      }

      if (this._incomingHeader.length >= PACKET_HEADER_MAX) {
        throw new Error("Failed to parse packet header!");
      }

      // Not enough data yet.
      return false;
    },

    /**
     * If the incoming packet is done, log it as needed and clear the buffer.
     */
    _flushIncoming: function() {
      if (!this._incoming.done) {
        return;
      }
      if (flags.wantLogging) {
        dumpn("Got: " + this._incoming);
      }
      this._destroyIncoming();
    },

    /**
     * Handler triggered by an incoming JSONPacket completing it's |read| method.
     * Delivers the packet to this.hooks.onPacket.
     */
    _onJSONObjectReady: function(object) {
      DevToolsUtils.executeSoon(DevToolsUtils.makeInfallible(() => {
      // Ensure the transport is still alive by the time this runs.
        if (this.active) {
          this.emit("packet", object);
          this.hooks.onPacket(object);
        }
      }, "DebuggerTransport instance's this.hooks.onPacket"));
    },

    /**
     * Handler triggered by an incoming BulkPacket entering the |read| phase for
     * the stream portion of the packet.  Delivers info about the incoming
     * streaming data to this.hooks.onBulkPacket.  See the main comment on the
     * transport at the top of this file for more details.
     */
    _onBulkReadReady: function(...args) {
      DevToolsUtils.executeSoon(DevToolsUtils.makeInfallible(() => {
      // Ensure the transport is still alive by the time this runs.
        if (this.active) {
          this.emit("bulkpacket", ...args);
          this.hooks.onBulkPacket(...args);
        }
      }, "DebuggerTransport instance's this.hooks.onBulkPacket"));
    },

    /**
     * Remove all handlers and references related to the current incoming packet,
     * either because it is now complete or because the transport is closing.
     */
    _destroyIncoming: function() {
      if (this._incoming) {
        this._incoming.destroy();
      }
      this._incomingHeader = "";
      this._incoming = null;
    }

  };

  exports.DebuggerTransport = DebuggerTransport;

  /**
   * An adapter that handles data transfers between the debugger client and
   * server when they both run in the same process. It presents the same API as
   * DebuggerTransport, but instead of transmitting serialized messages across a
   * connection it merely calls the packet dispatcher of the other side.
   *
   * @param other LocalDebuggerTransport
   *        The other endpoint for this debugger connection.
   *
   * @see DebuggerTransport
   */
  function LocalDebuggerTransport(other) {
    EventEmitter.decorate(this);

    this.other = other;
    this.hooks = null;

    // A packet number, shared between this and this.other. This isn't used by the
    // protocol at all, but it makes the packet traces a lot easier to follow.
    this._serial = this.other ? this.other._serial : { count: 0 };
    this.close = this.close.bind(this);
  }

  LocalDebuggerTransport.prototype = {
    /**
     * Transmit a message by directly calling the onPacket handler of the other
     * endpoint.
     */
    send: function(packet) {
      this.emit("send", packet);

      let serial = this._serial.count++;
      if (flags.wantLogging) {
        // Check 'from' first, as 'echo' packets have both.
        if (packet.from) {
          dumpn("Packet " + serial + " sent from " + uneval(packet.from));
        } else if (packet.to) {
          dumpn("Packet " + serial + " sent to " + uneval(packet.to));
        }
      }
      this._deepFreeze(packet);
      let other = this.other;
      if (other) {
        DevToolsUtils.executeSoon(DevToolsUtils.makeInfallible(() => {
          // Avoid the cost of JSON.stringify() when logging is disabled.
          if (flags.wantLogging) {
            dumpn("Received packet " + serial + ": " + JSON.stringify(packet, null, 2));
          }
          if (other.hooks) {
            other.emit("packet", packet);
            other.hooks.onPacket(packet);
          }
        }, "LocalDebuggerTransport instance's this.other.hooks.onPacket"));
      }
    },

    /**
     * Send a streaming bulk packet directly to the onBulkPacket handler of the
     * other endpoint.
     *
     * This case is much simpler than the full DebuggerTransport, since there is
     * no primary stream we have to worry about managing while we hand it off to
     * others temporarily.  Instead, we can just make a single use pipe and be
     * done with it.
     */
    startBulkSend: function({actor, type, length}) {
      this.emit("startbulksend", {actor, type, length});

      let serial = this._serial.count++;

      dumpn("Sent bulk packet " + serial + " for actor " + actor);
      if (!this.other) {
        let error = new Error("startBulkSend: other side of transport missing");
        return promise.reject(error);
      }

      let pipe = new Pipe(true, true, 0, 0, null);

      DevToolsUtils.executeSoon(DevToolsUtils.makeInfallible(() => {
        dumpn("Received bulk packet " + serial);
        if (!this.other.hooks) {
          return;
        }

        // Receiver
        let deferred = defer();
        let packet = {
          actor: actor,
          type: type,
          length: length,
          copyTo: (output) => {
            let copying =
            StreamUtils.copyStream(pipe.inputStream, output, length);
            deferred.resolve(copying);
            return copying;
          },
          stream: pipe.inputStream,
          done: deferred
        };

        this.other.emit("bulkpacket", packet);
        this.other.hooks.onBulkPacket(packet);

        // Await the result of reading from the stream
        deferred.promise.then(() => pipe.inputStream.close(), this.close);
      }, "LocalDebuggerTransport instance's this.other.hooks.onBulkPacket"));

      // Sender
      let sendDeferred = defer();

      // The remote transport is not capable of resolving immediately here, so we
      // shouldn't be able to either.
      DevToolsUtils.executeSoon(() => {
        let copyDeferred = defer();

        sendDeferred.resolve({
          copyFrom: (input) => {
            let copying =
            StreamUtils.copyStream(input, pipe.outputStream, length);
            copyDeferred.resolve(copying);
            return copying;
          },
          stream: pipe.outputStream,
          done: copyDeferred
        });

        // Await the result of writing to the stream
        copyDeferred.promise.then(() => pipe.outputStream.close(), this.close);
      });

      return sendDeferred.promise;
    },

    /**
     * Close the transport.
     */
    close: function() {
      this.emit("close");

      if (this.other) {
        // Remove the reference to the other endpoint before calling close(), to
        // avoid infinite recursion.
        let other = this.other;
        this.other = null;
        other.close();
      }
      if (this.hooks) {
        try {
          this.hooks.onClosed();
        } catch (ex) {
          console.error(ex);
        }
        this.hooks = null;
      }
    },

    /**
     * An empty method for emulating the DebuggerTransport API.
     */
    ready: function() {},

    /**
     * Helper function that makes an object fully immutable.
     */
    _deepFreeze: function(object) {
      Object.freeze(object);
      for (let prop in object) {
        // Freeze the properties that are objects, not on the prototype, and not
        // already frozen. Note that this might leave an unfrozen reference
        // somewhere in the object if there is an already frozen object containing
        // an unfrozen object.
        if (object.hasOwnProperty(prop) && typeof object === "object" &&
            !Object.isFrozen(object)) {
          this._deepFreeze(object[prop]);
        }
      }
    }
  };

  exports.LocalDebuggerTransport = LocalDebuggerTransport;

  /**
   * A transport for the debugging protocol that uses nsIMessageManagers to
   * exchange packets with servers running in child processes.
   *
   * In the parent process, |mm| should be the nsIMessageSender for the
   * child process. In a child process, |mm| should be the child process
   * message manager, which sends packets to the parent.
   *
   * |prefix| is a string included in the message names, to distinguish
   * multiple servers running in the same child process.
   *
   * This transport exchanges messages named 'debug:<prefix>:packet', where
   * <prefix> is |prefix|, whose data is the protocol packet.
   */
  function ChildDebuggerTransport(mm, prefix) {
    EventEmitter.decorate(this);

    this._mm = mm;
    this._messageName = "debug:" + prefix + ":packet";
  }

  /*
   * To avoid confusion, we use 'message' to mean something that
   * nsIMessageSender conveys, and 'packet' to mean a remote debugging
   * protocol packet.
   */
  ChildDebuggerTransport.prototype = {
    constructor: ChildDebuggerTransport,

    hooks: null,

    _addListener() {
      this._mm.addMessageListener(this._messageName, this);
    },

    _removeListener() {
      try {
        this._mm.removeMessageListener(this._messageName, this);
      } catch (e) {
        if (e.result != Cr.NS_ERROR_NULL_POINTER) {
          throw e;
        }
        // In some cases, especially when using messageManagers in non-e10s mode, we reach
        // this point with a dead messageManager which only throws errors but does not
        // seem to indicate in any other way that it is dead.
      }
    },

    ready: function() {
      this._addListener();
    },

    close: function() {
      this._removeListener();
      this.emit("close");
      this.hooks.onClosed();
    },

    receiveMessage: function({data}) {
      this.emit("packet", data);
      this.hooks.onPacket(data);
    },

    send: function(packet) {
      this.emit("send", packet);
      try {
        this._mm.sendAsyncMessage(this._messageName, packet);
      } catch (e) {
        if (e.result != Cr.NS_ERROR_NULL_POINTER) {
          throw e;
        }
        // In some cases, especially when using messageManagers in non-e10s mode, we reach
        // this point with a dead messageManager which only throws errors but does not
        // seem to indicate in any other way that it is dead.
      }
    },

    startBulkSend: function() {
      throw new Error("Can't send bulk data to child processes.");
    },

    swapBrowser(mm) {
      this._removeListener();
      this._mm = mm;
      this._addListener();
    },
  };

  exports.ChildDebuggerTransport = ChildDebuggerTransport;

  // WorkerDebuggerTransport is defined differently depending on whether we are
  // on the main thread or a worker thread. In the former case, we are required
  // by the devtools loader, and isWorker will be false. Otherwise, we are
  // required by the worker loader, and isWorker will be true.
  //
  // Each worker debugger supports only a single connection to the main thread.
  // However, its theoretically possible for multiple servers to connect to the
  // same worker. Consequently, each transport has a connection id, to allow
  // messages from multiple connections to be multiplexed on a single channel.

  if (!this.isWorker) {
    // Main thread
    (function() {
      /**
       * A transport that uses a WorkerDebugger to send packets from the main
       * thread to a worker thread.
       */
      function WorkerDebuggerTransport(dbg, id) {
        this._dbg = dbg;
        this._id = id;
        this.onMessage = this._onMessage.bind(this);
      }

      WorkerDebuggerTransport.prototype = {
        constructor: WorkerDebuggerTransport,

        ready: function() {
          this._dbg.addListener(this);
        },

        close: function() {
          this._dbg.removeListener(this);
          if (this.hooks) {
            this.hooks.onClosed();
          }
        },

        send: function(packet) {
          this._dbg.postMessage(JSON.stringify({
            type: "message",
            id: this._id,
            message: packet
          }));
        },

        startBulkSend: function() {
          throw new Error("Can't send bulk data from worker threads!");
        },

        _onMessage: function(message) {
          let packet = JSON.parse(message);
          if (packet.type !== "message" || packet.id !== this._id) {
            return;
          }

          if (this.hooks) {
            this.hooks.onPacket(packet.message);
          }
        }
      };

      exports.WorkerDebuggerTransport = WorkerDebuggerTransport;
    }).call(this);
  } else {
    // Worker thread
    (function() {
      /**
       * A transport that uses a WorkerDebuggerGlobalScope to send packets from a
       * worker thread to the main thread.
       */
      function WorkerDebuggerTransport(scope, id) {
        this._scope = scope;
        this._id = id;
        this._onMessage = this._onMessage.bind(this);
      }

      WorkerDebuggerTransport.prototype = {
        constructor: WorkerDebuggerTransport,

        ready: function() {
          this._scope.addEventListener("message", this._onMessage);
        },

        close: function() {
          this._scope.removeEventListener("message", this._onMessage);
          if (this.hooks) {
            this.hooks.onClosed();
          }
        },

        send: function(packet) {
          this._scope.postMessage(JSON.stringify({
            type: "message",
            id: this._id,
            message: packet
          }));
        },

        startBulkSend: function() {
          throw new Error("Can't send bulk data from worker threads!");
        },

        _onMessage: function(event) {
          let packet = JSON.parse(event.data);
          if (packet.type !== "message" || packet.id !== this._id) {
            return;
          }

          if (this.hooks) {
            this.hooks.onPacket(packet.message);
          }
        }
      };

      exports.WorkerDebuggerTransport = WorkerDebuggerTransport;
    }).call(this);
  }
});
