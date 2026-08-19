/*! coi-serviceworker v0.1.7 - Guido Zuidhof and contributors, licensed under MIT */
/*
 * This service worker intercepts all fetch responses and adds the headers
 * required for cross-origin isolation (SharedArrayBuffer support):
 *   Cross-Origin-Embedder-Policy: require-corp
 *   Cross-Origin-Opener-Policy: same-origin
 *
 * On GitHub Pages (and similar hosts) you cannot set server headers,
 * so this service worker injects them client-side.
 */
if (typeof window === "undefined") {
  // --- Service Worker context ---
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) =>
    event.waitUntil(self.clients.claim())
  );

  self.addEventListener("message", (ev) => {
    if (ev.data && ev.data.type === "deregister") {
      self.registration
        .unregister()
        .then(() => self.clients.matchAll())
        .then((clients) => {
          clients.forEach((client) => client.navigate(client.url));
        });
    }
  });

  self.addEventListener("fetch", function (event) {
    const r = event.request;
    if (r.cache === "only-if-cached" && r.mode !== "same-origin") {
      return;
    }

    event.respondWith(
      fetch(r)
        .then((response) => {
          if (response.status === 0) {
            return response;
          }

          const newHeaders = new Headers(response.headers);
          newHeaders.set("Cross-Origin-Embedder-Policy",
            (self.coepCredentialless && coepCredentialless())
              ? "credentialless"
              : "require-corp"
          );
          newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");

          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders,
          });
        })
        .catch((e) => console.error(e))
    );
  });
} else {
  // --- Window context ---
  (() => {
    const reloadedByCOI = window.sessionStorage.getItem("coiReloadedByCOI");
    window.sessionStorage.removeItem("coiReloadedByCOI");

    const coiConfig = {
      shouldRegister: () => true,
      shouldDeregister: () => false,
      coepCredentialless: () => (window.coepCredentialless !== undefined ? window.coepCredentialless : false),
      doReload: () => (window.coiDoReload !== undefined ? window.coiDoReload : !reloadedByCOI),
      quiet: false,
      ...window.coi,
    };

    // Already cross-origin isolated — nothing to do
    if (window.crossOriginIsolated) {
      if (!coiConfig.quiet) {
        console.log("COOP/COEP: Already cross-origin isolated.");
      }
      return;
    }

    if (!window.isSecureContext) {
      if (!coiConfig.quiet) {
        console.log(
          "COOP/COEP: Service worker registration requires a secure context (HTTPS)."
        );
      }
      return;
    }

    if (coiConfig.shouldDeregister()) {
      navigator.serviceWorker.controller &&
        navigator.serviceWorker.controller.postMessage({
          type: "deregister",
        });
      return;
    }

    if (!coiConfig.shouldRegister()) {
      if (!coiConfig.quiet) {
        console.log("COOP/COEP: Will not register service worker.");
      }
      return;
    }

    // Determine service worker URL relative to current page
    if (!navigator.serviceWorker) {
      console.error(
        "COOP/COEP: Service workers are not supported. SharedArrayBuffer will not work."
      );
      return;
    }

    navigator.serviceWorker
      .register(new URL("coi-serviceworker.js", window.location.href).href)
      .then(
        (registration) => {
          if (!coiConfig.quiet) {
            console.log("COOP/COEP: Registered service worker.");
          }

          registration.addEventListener("updatefound", () => {
            if (!coiConfig.quiet) {
              console.log(
                "COOP/COEP: New service worker found, reloading to activate headers."
              );
            }
            window.sessionStorage.setItem("coiReloadedByCOI", "true");
            if (coiConfig.doReload()) {
              window.location.reload();
            }
          });

          // If already active but page isn't isolated, reload once
          if (registration.active && !navigator.serviceWorker.controller) {
            if (!coiConfig.quiet) {
              console.log(
                "COOP/COEP: Service worker active but not controlling, reloading."
              );
            }
            window.sessionStorage.setItem("coiReloadedByCOI", "true");
            if (coiConfig.doReload()) {
              window.location.reload();
            }
          }
        },
        (err) => {
          console.error("COOP/COEP: Service worker registration failed:", err);
        }
      );
  })();
}

function coepCredentialless() {
  const ifr = document.createElement("iframe");
  ifr.setAttribute("credentialless", "");
  return ifr.credentialless === true;
}
