/* Ünal Büyüksungur — kullanıcı tarafından onaylanan V2 dış bağlantıları.
   URL'ler tek kanonik kaynaktan bütün V2 görünümlerine uygulanır. */
(function () {
    "use strict";

    var LINKS = Object.freeze({
        linkedin: Object.freeze({ platform: "LinkedIn", display: "Ünal Büyüksungur", url: "https://www.linkedin.com/in/ünal-büyüksungur-9ba3489b" }),
        instagram: Object.freeze({ platform: "Instagram", display: "@unalbuyuksungurmusic", url: "https://www.instagram.com/unalbuyuksungurmusic/" }),
        facebook: Object.freeze({ platform: "Facebook", display: "Ünal Büyüksungur", url: "https://www.facebook.com/unalbsungur/" }),
        youtube: Object.freeze({ platform: "YouTube", display: "@UnalBuyuksungurMusic", url: "https://www.youtube.com/@UnalBuyuksungurMusic" }),
        tiktok: Object.freeze({ platform: "TikTok", display: "@unal.buyuksungur", url: "https://www.tiktok.com/@unal.buyuksungur" }),
        spotify: Object.freeze({ platform: "Spotify", display: "Ünal Büyüksungur", url: "https://open.spotify.com/intl-tr/artist/57rcIXBqGaiGj9bje71Jkz?si=joU3pNjdQIuA9-UHTwq42Q" }),
        youtubeMusic: Object.freeze({ platform: "YouTube Music", display: "Ünal Büyüksungur Music", url: "https://music.youtube.com/@unalbuyuksungurmusic" }),
        appleMusic: Object.freeze({ platform: "Apple Music", display: "Ünal Büyüksungur", url: "https://music.apple.com/us/artist/%C3%BCnal-b%C3%BCy%C3%BCksungur/1868323918" }),
        blog: Object.freeze({ platform: "ÜNALBLOG", display: "ÜNALBLOG", url: "https://unalbsungur.blogspot.com/" }),
        shopier: Object.freeze({ platform: "Shopier", display: "Shopier Mağazam", url: "https://www.shopier.com/unalbuyuksungur/" })
    });

    function applyExternalLinks(root) {
        (root || document).querySelectorAll("a[data-external-link]").forEach(function (anchor) {
            var link = LINKS[anchor.getAttribute("data-external-link")];
            if (!link) return;
            anchor.href = link.url;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
            anchor.setAttribute("aria-label", (anchor.getAttribute("data-external-label") || link.platform + " — " + link.display) + " (yeni sekmede açılır)");
            anchor.querySelectorAll("[data-external-platform]").forEach(function (node) { node.textContent = link.platform; });
            anchor.querySelectorAll("[data-external-display]").forEach(function (node) { node.textContent = link.display; });
        });
    }

    Object.defineProperty(window, "V2_EXTERNAL_LINKS", { value: LINKS, writable: false, configurable: false });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { applyExternalLinks(document); });
    else applyExternalLinks(document);
}());
