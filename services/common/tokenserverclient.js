/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var EXPORTED_SYMBOLS = [
  "TokenServerClient",
  "TokenServerClientError",
  "TokenServerClientNetworkError",
  "TokenServerClientServerError",
];

ChromeUtils.import("resource://gre/modules/Services.jsm");
ChromeUtils.import("resource://gre/modules/Log.jsm");
ChromeUtils.import("resource://services-common/rest.js");
ChromeUtils.import("resource://services-common/observers.js");

const PREF_LOG_LEVEL = "services.common.log.logger.tokenserverclient";

/**
 * Represents a TokenServerClient error that occurred on the client.
 *
 * This is the base type for all errors raised by client operations.
 *
 * @param message
 *        (string) Error message.
 */
function TokenServerClientError(message) {
  this.name = "TokenServerClientError";
  this.message = message || "Client error.";
  // Without explicitly setting .stack, all stacks from these errors will point
  // to the "new Error()" call a few lines down, which isn't helpful.
  this.stack = Error().stack;
}
TokenServerClientError.prototype = new Error();
TokenServerClientError.prototype.constructor = TokenServerClientError;
TokenServerClientError.prototype._toStringFields = function() {
  return {message: this.message};
};
TokenServerClientError.prototype.toString = function() {
  return this.name + "(" + JSON.stringify(this._toStringFields()) + ")";
};
TokenServerClientError.prototype.toJSON = function() {
  let result = this._toStringFields();
  result.name = this.name;
  return result;
};

/**
 * Represents a TokenServerClient error that occurred in the network layer.
 *
 * @param error
 *        The underlying error thrown by the network layer.
 */
function TokenServerClientNetworkError(error) {
  this.name = "TokenServerClientNetworkError";
  this.error = error;
  this.stack = Error().stack;
}
TokenServerClientNetworkError.prototype = new TokenServerClientError();
TokenServerClientNetworkError.prototype.constructor =
  TokenServerClientNetworkError;
TokenServerClientNetworkError.prototype._toStringFields = function() {
  return {error: this.error};
};

/**
 * Represents a TokenServerClient error that occurred on the server.
 *
 * This type will be encountered for all non-200 response codes from the
 * server. The type of error is strongly enumerated and is stored in the
 * `cause` property. This property can have the following string values:
 *
 *   conditions-required -- The server is requesting that the client
 *     agree to service conditions before it can obtain a token. The
 *     conditions that must be presented to the user and agreed to are in
 *     the `urls` mapping on the instance. Keys of this mapping are
 *     identifiers. Values are string URLs.
 *
 *   invalid-credentials -- A token could not be obtained because
 *     the credentials presented by the client were invalid.
 *
 *   unknown-service -- The requested service was not found.
 *
 *   malformed-request -- The server rejected the request because it
 *     was invalid. If you see this, code in this file is likely wrong.
 *
 *   malformed-response -- The response from the server was not what was
 *     expected.
 *
 *   general -- A general server error has occurred. Clients should
 *     interpret this as an opaque failure.
 *
 * @param message
 *        (string) Error message.
 */
function TokenServerClientServerError(message, cause = "general") {
  this.now = new Date().toISOString(); // may be useful to diagnose time-skew issues.
  this.name = "TokenServerClientServerError";
  this.message = message || "Server error.";
  this.cause = cause;
  this.stack = Error().stack;
}
TokenServerClientServerError.prototype = new TokenServerClientError();
TokenServerClientServerError.prototype.constructor =
  TokenServerClientServerError;

TokenServerClientServerError.prototype._toStringFields = function() {
  let fields = {
    now: this.now,
    message: this.message,
    cause: this.cause,
  };
  if (this.response) {
    fields.response_body = this.response.body;
    fields.response_headers = this.response.headers;
    fields.response_status = this.response.status;
  }
  return fields;
};

/**
 * Represents a client to the Token Server.
 *
 * http://docs.services.mozilla.com/token/index.html
 *
 * The Token Server supports obtaining tokens for arbitrary apps by
 * constructing URI paths of the form <app>/<app_version>. However, the service
 * discovery mechanism emphasizes the use of full URIs and tries to not force
 * the client to manipulate URIs. This client currently enforces this practice
 * by not implementing an API which would perform URI manipulation.
 *
 * If you are tempted to implement this API in the future, consider this your
 * warning that you may be doing it wrong and that you should store full URIs
 * instead.
 *
 * Areas to Improve:
 *
 *  - The server sends a JSON response on error. The client does not currently
 *    parse this. It might be convenient if it did.
 *  - Currently most non-200 status codes are rolled into one error type. It
 *    might be helpful if callers had a richer API that communicated who was
 *    at fault (e.g. differentiating a 503 from a 401).
 */
function TokenServerClient() {
  this._log = Log.repository.getLogger("Services.Common.TokenServerClient");
  this._log.manageLevelFromPref(PREF_LOG_LEVEL);
}
TokenServerClient.prototype = {
  /**
   * Logger instance.
   */
  _log: null,

  /**
   * Obtain a token from a BrowserID assertion against a specific URL.
   *
   * This asynchronously obtains the token. The callback receives 2 arguments:
   *
   *   (TokenServerClientError | null) If no token could be obtained, this
   *     will be a TokenServerClientError instance describing why. The
   *     type seen defines the type of error encountered. If an HTTP response
   *     was seen, a RESTResponse instance will be stored in the `response`
   *     property of this object. If there was no error and a token is
   *     available, this will be null.
   *
   *   (map | null) On success, this will be a map containing the results from
   *     the server. If there was an error, this will be null. The map has the
   *     following properties:
   *
   *       id       (string) HTTP MAC public key identifier.
   *       key      (string) HTTP MAC shared symmetric key.
   *       endpoint (string) URL where service can be connected to.
   *       uid      (string) user ID for requested service.
   *       duration (string) the validity duration of the issued token.
   *
   * Terms of Service Acceptance
   * ---------------------------
   *
   * Some services require users to accept terms of service before they can
   * obtain a token. If a service requires ToS acceptance, the error passed
   * to the callback will be a `TokenServerClientServerError` with the
   * `cause` property set to "conditions-required". The `urls` property of that
   * instance will be a map of string keys to string URL values. The user-agent
   * should prompt the user to accept the content at these URLs.
   *
   * Clients signify acceptance of the terms of service by sending a token
   * request with additional metadata. This is controlled by the
   * `conditionsAccepted` argument to this function. Clients only need to set
   * this flag once per service and the server remembers acceptance. If
   * the conditions for the service change, the server may request
   * clients agree to terms again. Therefore, clients should always be
   * prepared to handle a conditions required response.
   *
   * Clients should not blindly send acceptance to conditions. Instead, clients
   * should set `conditionsAccepted` if and only if the server asks for
   * acceptance, the conditions are displayed to the user, and the user agrees
   * to them.
   *
   * Example Usage
   * -------------
   *
   *   let client = new TokenServerClient();
   *   let assertion = getBrowserIDAssertionFromSomewhere();
   *   let url = "https://token.services.mozilla.com/1.0/sync/2.0";
   *
   *   try {
   *     const result = await client.getTokenFromBrowserIDAssertion(url, assertion);
   *     let {id, key, uid, endpoint, duration} = result;
   *     // Do stuff with data and carry on.
   *   } catch (error) {
   *     // Handle errors.
   *   }
   *
   * @param  url
   *         (string) URL to fetch token from.
   * @param  assertion
   *         (string) BrowserID assertion to exchange token for.
   * @param  conditionsAccepted
   *         (bool) Whether to send acceptance to service conditions.
   */
  async getTokenFromBrowserIDAssertion(url, assertion, addHeaders = {}) {
    if (!url) {
      throw new TokenServerClientError("url argument is not valid.");
    }

    if (!assertion) {
      throw new TokenServerClientError("assertion argument is not valid.");
    }

    this._log.debug("Beginning BID assertion exchange: " + url);

    let req = this.newRESTRequest(url);
    req.setHeader("Accept", "application/json");
    req.setHeader("Authorization", "BrowserID " + assertion);

    for (let header in addHeaders) {
      req.setHeader(header, addHeaders[header]);
    }
    let response;
    try {
      response = await req.get();
    } catch (err) {
      throw new TokenServerClientNetworkError(err);
    }

    try {
      return this._processTokenResponse(response);
    } catch (ex) {
      if (ex instanceof TokenServerClientServerError) {
        throw ex;
      }
      this._log.warn("Error processing token server response", ex);
      let error = new TokenServerClientError(ex);
      error.response = response;
      throw error;
    }
  },

  /**
   * Handler to process token request responses.
   *
   * @param response
   *        RESTResponse from token HTTP request.
   */
  _processTokenResponse(response) {
    this._log.debug("Got token response: " + response.status);

    // Responses should *always* be JSON, even in the case of 4xx and 5xx
    // errors. If we don't see JSON, the server is likely very unhappy.
    let ct = response.headers["content-type"] || "";
    if (ct != "application/json" && !ct.startsWith("application/json;")) {
      this._log.warn("Did not receive JSON response. Misconfigured server?");
      this._log.debug("Content-Type: " + ct);
      this._log.debug("Body: " + response.body);

      let error = new TokenServerClientServerError("Non-JSON response.",
                                                   "malformed-response");
      error.response = response;
      throw error;
    }

    let result;
    try {
      result = JSON.parse(response.body);
    } catch (ex) {
      this._log.warn("Invalid JSON returned by server: " + response.body);
      let error = new TokenServerClientServerError("Malformed JSON.",
                                                   "malformed-response");
      error.response = response;
      throw error;
    }

    // Any response status can have X-Backoff or X-Weave-Backoff headers.
    this._maybeNotifyBackoff(response, "x-weave-backoff");
    this._maybeNotifyBackoff(response, "x-backoff");

    // The service shouldn't have any 3xx, so we don't need to handle those.
    if (response.status != 200) {
      // We /should/ have a Cornice error report in the JSON. We log that to
      // help with debugging.
      if ("errors" in result) {
        // This could throw, but this entire function is wrapped in a try. If
        // the server is sending something not an array of objects, it has
        // failed to keep its contract with us and there is little we can do.
        for (let error of result.errors) {
          this._log.info("Server-reported error: " + JSON.stringify(error));
        }
      }

      let error = new TokenServerClientServerError();
      error.response = response;

      if (response.status == 400) {
        error.message = "Malformed request.";
        error.cause = "malformed-request";
      } else if (response.status == 401) {
        // Cause can be invalid-credentials, invalid-timestamp, or
        // invalid-generation.
        error.message = "Authentication failed.";
        error.cause = result.status;
      } else if (response.status == 403) {
        // 403 should represent a "condition acceptance needed" response.
        //
        // The extra validation of "urls" is important. We don't want to signal
        // conditions required unless we are absolutely sure that is what the
        // server is asking for.
        if (!("urls" in result)) {
          this._log.warn("403 response without proper fields!");
          this._log.warn("Response body: " + response.body);

          error.message = "Missing JSON fields.";
          error.cause = "malformed-response";
        } else if (typeof(result.urls) != "object") {
          error.message = "urls field is not a map.";
          error.cause = "malformed-response";
        } else {
          error.message = "Conditions must be accepted.";
          error.cause = "conditions-required";
          error.urls = result.urls;
        }
      } else if (response.status == 404) {
        error.message = "Unknown service.";
        error.cause = "unknown-service";
      }

      // A Retry-After header should theoretically only appear on a 503, but
      // we'll look for it on any error response.
      this._maybeNotifyBackoff(response, "retry-after");

      throw error;
    }

    for (let k of ["id", "key", "api_endpoint", "uid", "duration"]) {
      if (!(k in result)) {
        let error = new TokenServerClientServerError("Expected key not " +
                                                     " present in result: " +
                                                     k);
        error.cause = "malformed-response";
        error.response = response;
        throw error;
      }
    }

    this._log.debug("Successful token response");
    return {
      id:             result.id,
      key:            result.key,
      endpoint:       result.api_endpoint,
      uid:            result.uid,
      duration:       result.duration,
      hashed_fxa_uid: result.hashed_fxa_uid,
    };
  },

  /*
   * The prefix used for all notifications sent by this module.  This
   * allows the handler of notifications to be sure they are handling
   * notifications for the service they expect.
   *
   * If not set, no notifications will be sent.
   */
  observerPrefix: null,

  // Given an optional header value, notify that a backoff has been requested.
  _maybeNotifyBackoff(response, headerName) {
    if (!this.observerPrefix) {
      return;
    }
    let headerVal = response.headers[headerName];
    if (!headerVal) {
      return;
    }
    let backoffInterval;
    try {
      backoffInterval = parseInt(headerVal, 10);
    } catch (ex) {
      this._log.error("TokenServer response had invalid backoff value in '" +
                      headerName + "' header: " + headerVal);
      return;
    }
    Observers.notify(this.observerPrefix + ":backoff:interval", backoffInterval);
  },

  // override points for testing.
  newRESTRequest(url) {
    return new RESTRequest(url);
  }
};
