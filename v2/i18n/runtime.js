/* URL is the authority for UI locale. Browser language never redirects a visitor. */
(function () {
    "use strict";
    var script = document.currentScript;
    var root = new URL("../", script.src);
    var locales = { tr: true, en: true, de: true };
    var path = window.location.pathname;
    var base = root.pathname;
    var rest = path.indexOf(base) === 0 ? path.slice(base.length) : "";
    var current = rest.indexOf("en/") === 0 ? "en" : rest.indexOf("de/") === 0 ? "de" : "tr";
    var route = current === "tr" ? rest : rest.slice(3);
    var storageKey = "unal-v2-locale";

    function preference() {
        try {
            var saved = window.localStorage.getItem(storageKey);
            return locales[saved] ? saved : "tr";
        } catch (_error) {
            return "tr";
        }
    }

    function destination(locale) {
        locale = locales[locale] ? locale : "tr";
        return base + (locale === "tr" ? "" : locale + "/") + route + window.location.search + window.location.hash;
    }

    window.UNAL_UI = {
        locale: current,
        musicRoot: base + "music/",
        preference: preference,
        destination: destination
    };

    document.addEventListener("DOMContentLoaded", function () {
        document.querySelectorAll(".language-switcher a[data-locale]").forEach(function (link) {
            var locale = link.getAttribute("data-locale");
            if (!locales[locale]) return;
            link.href = destination(locale);
            if (locale === current) link.setAttribute("aria-current", "true");
            else link.removeAttribute("aria-current");
            link.addEventListener("click", function () {
                try { window.localStorage.setItem(storageKey, locale); } catch (_error) { /* Navigation still works. */ }
            });
        });
    });
})();
