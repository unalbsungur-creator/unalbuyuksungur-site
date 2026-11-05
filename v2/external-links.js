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
        // Görev 227: stüdyo satın alma ürünleri (Shopier). null = sipariş henüz açık değil; düğme pasif kalır.
        // Ürün URL'si girildiğinde stüdyo sayfasındaki düğme kendiliğinden etkinleşir.
        shopierOzelSarki: Object.freeze({ platform: "Shopier", display: "Özel Şarkı", url: null }),
        shopierOzelSarkiHaftaSonu: Object.freeze({ platform: "Shopier", display: "Özel Şarkı — Hafta Sonu Teslim", url: null }),
        shopierOzelSarkiPlus: Object.freeze({ platform: "Shopier", display: "Özel Şarkı Plus", url: null }),
        shopierOzelSarkiPlusHaftaSonu: Object.freeze({ platform: "Shopier", display: "Özel Şarkı Plus — Hafta Sonu Teslim", url: null })
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

    // Görev 227: statik HTML'de pasif (disabled) satın alma düğmeleri; anahtarın URL'si varsa yeni sekmede
    // açılan bağlantıya dönüşür. URL null ise statik pasif hal ("Siparişler çok yakında") olduğu gibi kalır.
    function applyPurchaseLinks(root) {
        (root || document).querySelectorAll("button[data-purchase-link]").forEach(function (button) {
            var link = LINKS[button.getAttribute("data-purchase-link")];
            if (!link || typeof link.url !== "string" || !/^https:\/\//.test(link.url)) return;
            var label = button.querySelector("[data-purchase-on]") || button;
            var anchor = document.createElement("a");
            anchor.className = button.className;
            anchor.href = link.url;
            anchor.target = "_blank";
            anchor.rel = "noopener noreferrer";
            anchor.textContent = label.textContent.trim();
            if (button.hasAttribute("aria-describedby")) anchor.setAttribute("aria-describedby", button.getAttribute("aria-describedby"));
            button.replaceWith(anchor);
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
