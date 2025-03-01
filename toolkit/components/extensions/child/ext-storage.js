"use strict";

ChromeUtils.defineModuleGetter(this, "ExtensionStorage",
                               "resource://gre/modules/ExtensionStorage.jsm");
ChromeUtils.defineModuleGetter(this, "TelemetryStopwatch",
                               "resource://gre/modules/TelemetryStopwatch.jsm");

var {
  ExtensionError,
} = ExtensionUtils;

const storageGetHistogram = "WEBEXT_STORAGE_LOCAL_GET_MS";
const storageSetHistogram = "WEBEXT_STORAGE_LOCAL_SET_MS";

this.storage = class extends ExtensionAPI {
  getAPI(context) {
    /**
     * Serializes the given storage items for transporting to the parent
     * process.
     *
     * @param {Array<string>|object} items
     *        The items to serialize. If an object is provided, its
     *        values are serialized to StructuredCloneHolder objects.
     *        Otherwise, it is returned as-is.
     * @returns {Array<string>|object}
     */
    function serialize(items) {
      if (items && typeof items === "object" && !Array.isArray(items)) {
        let result = {};
        for (let [key, value] of Object.entries(items)) {
          try {
            result[key] = new StructuredCloneHolder(value, context.cloneScope);
          } catch (e) {
            throw new ExtensionError(String(e));
          }
        }
        return result;
      }
      return items;
    }

    /**
     * Deserializes the given storage items from the parent process into
     * the extension context.
     *
     * @param {object} items
     *        The items to deserialize. Any property of the object which
     *        is a StructuredCloneHolder instance is deserialized into
     *        the extension scope. Any other object is cloned into the
     *        extension scope directly.
     * @returns {object}
     */
    function deserialize(items) {
      let result = new context.cloneScope.Object();
      for (let [key, value] of Object.entries(items)) {
        if (value && typeof value === "object" && Cu.getClassName(value, true) === "StructuredCloneHolder") {
          value = value.deserialize(context.cloneScope);
        } else {
          value = Cu.cloneInto(value, context.cloneScope);
        }
        result[key] = value;
      }
      return result;
    }

    function sanitize(items) {
      // The schema validator already takes care of arrays (which are only allowed
      // to contain strings). Strings and null are safe values.
      if (typeof items != "object" || items === null || Array.isArray(items)) {
        return items;
      }
      // If we got here, then `items` is an object generated by `ObjectType`'s
      // `normalize` method from Schemas.jsm. The object returned by `normalize`
      // lives in this compartment, while the values live in compartment of
      // `context.contentWindow`. The `sanitize` method runs with the principal
      // of `context`, so we cannot just use `ExtensionStorage.sanitize` because
      // it is not allowed to access properties of `items`.
      // So we enumerate all properties and sanitize each value individually.
      let sanitized = {};
      for (let [key, value] of Object.entries(items)) {
        sanitized[key] = ExtensionStorage.sanitize(value, context);
      }
      return sanitized;
    }

    return {
      storage: {
        local: {
          get: async function(keys) {
            const stopwatchKey = {};
            TelemetryStopwatch.start(storageGetHistogram, stopwatchKey);
            try {
              let result = await context.childManager.callParentAsyncFunction("storage.local.get", [
                serialize(keys),
              ]).then(deserialize);
              TelemetryStopwatch.finish(storageGetHistogram, stopwatchKey);
              return result;
            } catch (e) {
              TelemetryStopwatch.cancel(storageGetHistogram, stopwatchKey);
              throw e;
            }
          },
          set: async function(items) {
            const stopwatchKey = {};
            TelemetryStopwatch.start(storageSetHistogram, stopwatchKey);
            try {
              let result = await context.childManager.callParentAsyncFunction("storage.local.set", [
                serialize(items),
              ]);
              TelemetryStopwatch.finish(storageSetHistogram, stopwatchKey);
              return result;
            } catch (e) {
              TelemetryStopwatch.cancel(storageSetHistogram, stopwatchKey);
              throw e;
            }
          },
        },

        sync: {
          get: function(keys) {
            keys = sanitize(keys);
            return context.childManager.callParentAsyncFunction("storage.sync.get", [
              keys,
            ]);
          },
          set: function(items) {
            items = sanitize(items);
            return context.childManager.callParentAsyncFunction("storage.sync.set", [
              items,
            ]);
          },
        },

        managed: {
          get(keys) {
            return context.childManager.callParentAsyncFunction("storage.managed.get", [
              serialize(keys),
            ]).then(deserialize);
          },
          set(items) {
            return Promise.reject({message: "storage.managed is read-only"});
          },
          remove(keys) {
            return Promise.reject({message: "storage.managed is read-only"});
          },
          clear() {
            return Promise.reject({message: "storage.managed is read-only"});
          },
        },

        onChanged: new EventManager(context, "storage.onChanged", fire => {
          let onChanged = (data, area) => {
            let changes = new context.cloneScope.Object();
            for (let [key, value] of Object.entries(data)) {
              changes[key] = deserialize(value);
            }
            fire.raw(changes, area);
          };

          let parent = context.childManager.getParentEvent("storage.onChanged");
          parent.addListener(onChanged);
          return () => {
            parent.removeListener(onChanged);
          };
        }).api(),
      },
    };
  }
};
