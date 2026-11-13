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
        shopier: Object.freeze({ platform: "Shopier", display: "Shopier Mağazam", url: "https://www.shopier.com/unalbuyuksungur/" }),
        etsy: Object.freeze({ platform: "Etsy", display: "Pixel & Petal Digital", url: "https://pixelandpetaldigital.etsy.com" }),
        spotifyPlaylist: Object.freeze({ platform: "Spotify", display: "Ünal Büyüksungur", url: "https://open.spotify.com/playlist/6od7MgDo7kL9DHUgiT40rT" }),
        // Görev 227/228: stüdyo satın alma ürünleri (Shopier). Stüdyo sayfasındaki bağlantılar statik HTML'de de
        // aynı adreslerle yazılıdır (test_external_links eşitliği denetler).
        shopierOzelSarki: Object.freeze({ platform: "Shopier", display: "Özel Şarkı", url: "https://www.shopier.com/unalbuyuksungur/52596551" }),
        shopierOzelSarkiHaftaSonu: Object.freeze({ platform: "Shopier", display: "Özel Şarkı — Hafta Sonu Teslim", url: "https://www.shopier.com/unalbuyuksungur/52596592" }),
        shopierOzelSarkiPlus: Object.freeze({ platform: "Shopier", display: "Özel Şarkı Plus", url: "https://www.shopier.com/unalbuyuksungur/52596612" }),
        shopierOzelSarkiPlusHaftaSonu: Object.freeze({ platform: "Shopier", display: "Özel Şarkı Plus — Hafta Sonu Teslim", url: "https://www.shopier.com/unalbuyuksungur/52596627" }),
        // Görev 240: video sayfası (studio/video/) satın alma ürünleri; statik HTML'de de aynı adresler yazılıdır.
        shopierSarkiVideo: Object.freeze({ platform: "Shopier", display: "Özel Şarkı + Video", url: "https://www.shopier.com/unalbuyuksungur/52905449" }),
        shopierSarkiPlusVideo: Object.freeze({ platform: "Shopier", display: "Özel Şarkı Plus + Video", url: "https://www.shopier.com/unalbuyuksungur/52905472" }),
        shopierVideoKlip: Object.freeze({ platform: "Shopier", display: "Video Klip", url: "https://www.shopier.com/unalbuyuksungur/52905482" })
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

    // Görev 228: satın alma bağlantıları statik HTML'de etkin; çalışma anında adres tek kaynaktan yeniden uygulanır.
    function applyPurchaseLinks(root) {
        (root || document).querySelectorAll("a[data-purchase-link]").forEach(function (anchor) {
            var link = LINKS[anchor.getAttribute("data-purchase-link")];
            if (!link || typeof link.url !== "string" || !/^https:\/\//.test(link.url)) return;
            anchor.href = link.url;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
        });
    }

    function applyAll() {
        applyExternalLinks(document);
        applyPurchaseLinks(document);
    }

    Object.defineProperty(window, "V2_EXTERNAL_LINKS", { value: LINKS, writable: false, configurable: false });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", applyAll);
    else applyAll();
}());
