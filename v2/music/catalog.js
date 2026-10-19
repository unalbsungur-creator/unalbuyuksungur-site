/* Ünal Büyüksungur — Müzik Dünyam kataloğu
   Tek veri kaynağı: data/catalog.json. Framework yok, derleme adımı yok. */
(function () {
    "use strict";

    var CATALOG_URL = "data/catalog.json";
    var DETAIL_URL = "work/";
    var LANGUAGE_NAMES = { tr: "Türkçe", de: "Almanca" };
    // Galeri sütunlarıyla (4 / 3 / 2 / 1) uyumlu görüntü genişlikleri
    var CARD_SIZES = "(min-width: 1500px) 310px, (min-width: 1200px) 22vw, (min-width: 900px) 29vw, (min-width: 360px) 45vw, 90vw";
    var EAGER_CARDS = 4;
    var SEARCH_DELAY = 120;
    var EMPTY_TITLE = "Seçili arama ve filtrelerle eşleşen eser bulunamadı.";
    var EMPTY_HINT = "Farklı bir dil veya koleksiyon seçebilir ya da filtreleri temizleyebilirsiniz.";

    var collator = new Intl.Collator("tr", { sensitivity: "base", numeric: true });

    /* ---------- Yardımcılar ---------- */

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (key) {
            var value = attrs[key];
            if (value === null || value === undefined || value === false) return;
            if (key === "text") node.textContent = value;
            else if (key === "className") node.className = value;
            else node.setAttribute(key, value === true ? "" : value);
        });
        (children || []).forEach(function (child) {
            if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
        });
        return node;
    }

    function prefersReducedMotion() {
        return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    }

    /* ---------- Metin ve arama ---------- */

    // Türkçe ve Almanca karakterleri sadeleştirir: "Boğa" -> "boga", "Yüreğim" -> "yuregim"
    function normalize(text) {
        return String(text || "")
            .toLocaleLowerCase("tr")
            .replace(/ı/g, "i")
            .replace(/ß/g, "ss")
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .replace(/[^a-z0-9]+/g, " ")
            .trim();
    }

    function matchesQuery(work, query) {
        if (!query) return true;
        return query.split(" ").every(function (token) {
            return work.searchText.indexOf(token) !== -1;
        });
    }

    /* ---------- Görseller ---------- */

    // webImages.path, v2/music/ klasörüne göredir; bu sayfa da o klasörde.
    // SHA-256'nın ilk 12 karakteri önbellek sürümü olarak eklenir.
    function imageUrl(image) {
        return image.path + "?v=" + image.sha256.slice(0, 12);
    }

    function sortedImages(cover) {
        return cover.webImages.slice().sort(function (a, b) { return a.width - b.width; });
    }

    function coverImage(cover, options) {
        var images = sortedImages(cover);
        var fallback = images.filter(function (i) { return i.width >= options.minWidth; })[0] || images[images.length - 1];
        return el("img", {
            src: imageUrl(fallback),
            srcset: images.map(function (i) { return imageUrl(i) + " " + i.width + "w"; }).join(", "),
            sizes: options.sizes,
            width: fallback.width,
            height: fallback.height,
            alt: options.alt,
            loading: options.lazy ? "lazy" : null,
            decoding: "async"
        });
    }

    /* ---------- Veri ---------- */

    function loadCatalog() {
        return fetch(CATALOG_URL, { cache: "no-cache" }).then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
        }).then(function (catalog) {
            ["works", "recordings", "covers", "collections", "relations"].forEach(function (key) {
                if (!Array.isArray(catalog[key])) throw new Error("Eksik alan: " + key);
            });
            return catalog;
        });
    }

    function byId(list) {
        var map = {};
        list.forEach(function (item) { map[item.id] = item; });
        return map;
    }

    function buildIndex(catalog) {
        var covers = byId(catalog.covers);
        var collections = catalog.collections.slice().sort(function (a, b) { return a.order - b.order; });
        var recordingsByWork = {};
        catalog.recordings.forEach(function (recording) {
            (recordingsByWork[recording.workId] = recordingsByWork[recording.workId] || []).push(recording);
        });

        var membership = {};
        collections.forEach(function (collection) {
            collection.members.forEach(function (member, index) {
                (membership[member.workId] = membership[member.workId] || []).push({
                    collection: collection, index: index, dateRange: member.dateRange || null
                });
            });
        });

        // 'adaptation' ilişkisi yönsüzdür; iki taraftan da sorgulanır.
        var related = {};
        catalog.relations.forEach(function (relation) {
            [[relation.source, relation.target], [relation.target, relation.source]].forEach(function (pair) {
                (related[pair[0]] = related[pair[0]] || []).push({ workId: pair[1], type: relation.type });
            });
        });

        var works = catalog.works.map(function (work) {
            // Onaylı ilk kayıt başta; diğerleri kayıt kimliği sırasıyla.
            var recordings = (recordingsByWork[work.id] || []).slice().sort(function (a, b) {
                return (b.isOriginal === true) - (a.isOriginal === true) || collator.compare(a.id, b.id);
            });
            // Onaylı ilk kayıt varsa kapak ondan; yoksa en düşük kayıt kimliğinden alınır.
            var primary = recordings.filter(function (r) { return r.isOriginal === true; })[0] || recordings[0];
            var title = work.title || work.workingTitle || work.id;
            var member = membership[work.id] || [];
            return {
                id: work.id,
                data: work,
                title: title,
                titleConfirmed: work.titleStatus === "confirmed",
                language: work.language,
                recordings: recordings,
                cover: covers[primary.coverId],
                collections: member,
                related: related[work.id] || [],
                searchText: normalize([
                    title,
                    work.workingTitle,
                    LANGUAGE_NAMES[work.language],
                    recordings.map(function (r) { return r.title; }).join(" "),
                    member.map(function (m) { return m.collection.title; }).join(" ")
                ].join(" "))
            };
        }).sort(function (a, b) { return collator.compare(a.title, b.title); });

        var languages = [];
        works.forEach(function (work) {
            if (languages.indexOf(work.language) === -1) languages.push(work.language);
        });
        languages.sort(function (a, b) { return collator.compare(languageName(a), languageName(b)); });

        return {
            catalog: catalog,
            works: works,
            worksById: byId(works),
            covers: covers,
            collections: collections,
            collectionsBySlug: collections.reduce(function (map, c) { map[c.slug] = c; return map; }, {}),
            languages: languages
        };
    }

    function languageName(code) {
        return LANGUAGE_NAMES[code] || String(code).toUpperCase();
    }

    /* ---------- Filtre durumu ---------- */

    var state = { query: "", collection: "", language: "" };

    function readStateFromUrl(index) {
        var params = new URLSearchParams(window.location.search);
        var collection = params.get("koleksiyon") || "";
        var language = params.get("dil") || "";
        state.query = params.get("q") || "";
        state.collection = index.collectionsBySlug[collection] ? collection : "";
        state.language = index.languages.indexOf(language) !== -1 ? language : "";
    }

    // mode: "push" yeni geçmiş kaydı açar (koleksiyon kartı), "replace" mevcut kaydı günceller
    // (araç çubuğu), "none" URL'ye dokunmaz (geri/ileri). Aynı URL geçmişe tekrar eklenmez.
    function writeStateToUrl(mode) {
        if (mode === "none") return;
        var params = new URLSearchParams();
        if (state.query) params.set("q", state.query);
        if (state.collection) params.set("koleksiyon", state.collection);
        if (state.language) params.set("dil", state.language);
        var search = params.toString();
        var url = window.location.pathname + (search ? "?" + search : "") + window.location.hash;
        if (url === window.location.pathname + window.location.search + window.location.hash) return;
        if (mode === "push") window.history.pushState(null, "", url);
        else window.history.replaceState(null, "", url);
    }

    // Eser detay sayfası: work/?id=w-0001. Geçerli filtreler de eklenir ki
    // detay sayfasındaki "kataloğa dön" bağlantısı aynı görünüme geri getirsin.
    function detailUrl(workId) {
        var params = new URLSearchParams();
        if (state.query) params.set("q", state.query);
        if (state.collection) params.set("koleksiyon", state.collection);
        if (state.language) params.set("dil", state.language);
        var rest = params.toString();
        return DETAIL_URL + "?id=" + encodeURIComponent(workId) + (rest ? "&" + rest : "");
    }

    function isFiltered() {
        return Boolean(state.query || state.collection || state.language);
    }

    function filterWorks(index) {
        var query = normalize(state.query);
        var visible = index.works.filter(function (work) {
            return matchesQuery(work, query)
                && (!state.language || work.language === state.language)
                && (!state.collection || work.collections.some(function (m) {
                    return m.collection.slug === state.collection;
                }));
        });
        if (state.collection) {
            // Koleksiyon seçiliyken koleksiyonun kendi sırası kullanılır (ör. Koç → Balık).
            var position = function (work) {
                return work.collections.filter(function (m) { return m.collection.slug === state.collection; })[0].index;
            };
            visible.sort(function (a, b) { return position(a) - position(b); });
        }
        return visible;
    }

    /* ---------- Çizim ---------- */

    var dom = {};

    function renderStats(index) {
        dom.stats.querySelector('[data-stat="works"]').textContent = index.works.length;
        dom.stats.querySelector('[data-stat="recordings"]').textContent = index.catalog.recordings.length;
        dom.stats.querySelector('[data-stat="collections"]').textContent = index.collections.length;
        dom.stats.hidden = false;
    }

    function renderCollections(index) {
        var arrow = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
        index.collections.forEach(function (collection) {
            var preview = collection.members.slice(0, 4);
            var mosaic = el("div", {
                className: "collection-mosaic",
                "data-tiles": preview.length,
                style: "--tiles: " + preview.length,
                "aria-hidden": "true"
            });
            preview.forEach(function (member) {
                var work = index.worksById[member.workId];
                mosaic.appendChild(coverImage(work.cover, { minWidth: 400, sizes: "160px", alt: "", lazy: false }));
            });
            var count = collection.members.length;
            var foot = el("div", { className: "collection-foot" }, [el("span", { text: "Eserleri göster" })]);
            foot.insertAdjacentHTML("beforeend", arrow);

            var card = el("article", { className: "collection-card", "data-collection": collection.slug }, [
                mosaic,
                el("div", { className: "collection-body" }, [
                    el("p", { className: "collection-count", text: count + " eser" }),
                    el("h3", {}, [el("button", {
                        className: "collection-open",
                        type: "button",
                        "data-collection": collection.slug,
                        "aria-controls": "work-grid",
                        text: collection.title
                    })]),
                    el("p", { className: "collection-text", text: collection.description }),
                    foot
                ])
            ]);
            dom.collectionGrid.appendChild(el("li", {}, [card]));
        });
        dom.collectionGrid.removeAttribute("aria-busy");
    }

    function chip(label, count, group, value) {
        return el("button", {
            className: "chip",
            type: "button",
            "data-group": group,
            "data-value": value,
            "aria-pressed": "false"
        }, [label, count === null ? null : el("span", { className: "chip-count", "aria-hidden": "true", text: String(count) })]);
    }

    function renderFilters(index) {
        dom.collectionFilter.appendChild(chip("Tümü", index.works.length, "collection", ""));
        index.collections.forEach(function (collection) {
            dom.collectionFilter.appendChild(chip(collection.title, collection.members.length, "collection", collection.slug));
        });
        dom.languageFilter.appendChild(chip("Tüm diller", null, "language", ""));
        index.languages.forEach(function (code) {
            var count = index.works.filter(function (w) { return w.language === code; }).length;
            dom.languageFilter.appendChild(chip(languageName(code), count, "language", code));
        });
    }

    function workCard(work, position) {
        var versions = work.recordings.length;
        var meta = [el("span", { text: languageName(work.language) })];
        work.collections.forEach(function (m) { meta.push(el("span", { text: m.collection.title })); });

        var cover = el("div", { className: "work-cover" }, [
            coverImage(work.cover, {
                minWidth: 400,
                sizes: CARD_SIZES,
                alt: work.title + " kapak görseli",
                lazy: position >= EAGER_CARDS
            }),
            versions > 1 ? el("span", { className: "version-badge", text: versions + " Versiyon" }) : null
        ]);

        var card = el("article", { className: "work-card" }, [
            cover,
            el("div", { className: "work-body" }, [
                el("h3", {}, [el("a", {
                    className: "work-open",
                    href: detailUrl(work.id),
                    "data-work": work.id,
                    "aria-label": work.title + (versions > 1 ? ", " + versions + " versiyon" : ""),
                    text: work.title
                })]),
                el("p", { className: "work-meta" }, meta)
            ])
        ]);
        return el("li", { "data-work": work.id }, [card]);
    }

    function renderWorks(index) {
        dom.cards = {};
        index.works.forEach(function (work, position) {
            var item = workCard(work, position);
            dom.cards[work.id] = item;
            dom.workGrid.appendChild(item);
        });
    }

    function updateView(index, historyMode) {
        var visible = filterWorks(index);
        var visibleIds = {};
        visible.forEach(function (work) { visibleIds[work.id] = true; });

        // Kartlar bir kez oluşturulur; filtreleme yalnızca görünürlüğü ve sırayı değiştirir.
        var ordered = state.collection ? visible.concat(index.works.filter(function (w) { return !visibleIds[w.id]; })) : index.works;
        ordered.forEach(function (work) {
            var item = dom.cards[work.id];
            item.hidden = !visibleIds[work.id];
            item.querySelector(".work-open").setAttribute("href", detailUrl(work.id));
            dom.workGrid.appendChild(item);
        });

        dom.chips().forEach(function (button) {
            var value = button.getAttribute("data-value");
            var active = button.getAttribute("data-group") === "collection" ? state.collection : state.language;
            button.setAttribute("aria-pressed", String(value === active));
        });
        dom.collectionGrid.querySelectorAll(".collection-card").forEach(function (card) {
            card.classList.toggle("is-active", card.getAttribute("data-collection") === state.collection);
        });

        var total = index.works.length;
        dom.resultCount.innerHTML = "";
        if (visible.length === total) {
            dom.resultCount.append("Tüm eserler gösteriliyor: ", el("strong", { text: String(total) }));
        } else {
            dom.resultCount.append(el("strong", { text: String(visible.length) }), " eser gösteriliyor (toplam " + total + ")");
        }
        if (!visible.length) {
            // Boş durum kutusu canlı bölge değildir; açıklama sonuç sayacıyla birlikte duyurulur.
            dom.resultCount.append(el("span", { className: "visually-hidden", text: ". " + EMPTY_TITLE }));
        }
        dom.emptyState.hidden = visible.length !== 0;
        dom.clearButton.disabled = !isFiltered();
        dom.heading.textContent = state.collection ? index.collectionsBySlug[state.collection].title : "Tüm Eserler";
        writeStateToUrl(historyMode || "replace");
    }

    function renderEmptyState() {
        dom.emptyState.querySelector(".state-title").textContent = EMPTY_TITLE;
        dom.emptyState.querySelector(".state-title + p").textContent = EMPTY_HINT;
    }

    /* ---------- Hata durumu ---------- */

    function showError(error, retry) {
        var hint = window.location.protocol === "file:"
            ? "Sayfa doğrudan dosya olarak açılmış görünüyor. Tarayıcılar bu durumda katalog verisinin yüklenmesine izin vermez; sayfayı bir yerel HTTP sunucusu üzerinden açın."
            : "Bağlantınızı kontrol edip yeniden deneyebilirsiniz.";
        var button = el("button", { className: "button button-secondary", type: "button", text: "Yeniden dene" });
        button.addEventListener("click", retry);
        dom.state.className = "state state--error";
        dom.state.setAttribute("role", "alert");
        dom.state.replaceChildren(
            el("p", { className: "state-title", text: "Katalog yüklenemedi." }),
            el("p", { text: hint }),
            el("p", { className: "visually-hidden", text: "Teknik ayrıntı: " + error.message }),
            button
        );
        dom.state.hidden = false;
        dom.collectionGrid.removeAttribute("aria-busy");
        dom.collectionGrid.closest("section").hidden = true;
    }

    /* ---------- Olaylar ---------- */

    function bindEvents(index) {
        var searchTimer = null;

        dom.toolbar.addEventListener("submit", function (event) {
            event.preventDefault();
            window.clearTimeout(searchTimer);
            state.query = dom.search.value.trim();
            updateView(index);
        });

        dom.search.addEventListener("input", function () {
            window.clearTimeout(searchTimer);
            searchTimer = window.setTimeout(function () {
                state.query = dom.search.value.trim();
                updateView(index);
            }, SEARCH_DELAY);
        });

        dom.toolbar.addEventListener("click", function (event) {
            var button = event.target.closest(".chip");
            if (!button) return;
            var value = button.getAttribute("data-value");
            if (button.getAttribute("data-group") === "collection") state.collection = value;
            else state.language = value;
            updateView(index);
        });

        function clearAll() {
            window.clearTimeout(searchTimer);
            state.query = "";
            state.collection = "";
            state.language = "";
            dom.search.value = "";
            updateView(index);
        }

        dom.clearButton.addEventListener("click", function () {
            clearAll();
            dom.search.focus();
        });
        dom.emptyState.querySelector('[data-action="clear"]').addEventListener("click", function () {
            clearAll();
            dom.search.focus();
        });

        // Koleksiyon kartı bir gezinmedir, filtre eklemez: koleksiyonun bütün eserleri görünür.
        // Araç çubuğundaki çipler ise birbirleriyle kesişerek çalışmaya devam eder.
        dom.collectionGrid.addEventListener("click", function (event) {
            var button = event.target.closest(".collection-open");
            if (!button) return;
            window.clearTimeout(searchTimer);
            state.collection = button.getAttribute("data-collection");
            state.language = "";
            state.query = "";
            dom.search.value = "";
            updateView(index, "push");
            dom.catalog.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
            dom.heading.focus({ preventScroll: true });
        });

        window.addEventListener("popstate", function () {
            window.clearTimeout(searchTimer);
            readStateFromUrl(index);
            dom.search.value = state.query;
            updateView(index, "none");
        });
    }

    function initNavigation() {
        var header = document.getElementById("site-header");
        var toggle = header.querySelector(".nav-toggle");
        var nav = document.getElementById("site-nav");

        function setOpen(open) {
            nav.classList.toggle("is-open", open);
            toggle.setAttribute("aria-expanded", String(open));
        }

        toggle.addEventListener("click", function () {
            setOpen(toggle.getAttribute("aria-expanded") !== "true");
        });

        nav.addEventListener("click", function (event) {
            if (event.target.closest("a")) setOpen(false);
        });

        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && nav.classList.contains("is-open")) {
                setOpen(false);
                toggle.focus();
            }
        });

        function onScroll() {
            header.classList.toggle("is-scrolled", window.scrollY > 24);
        }

        window.addEventListener("scroll", onScroll, { passive: true });
        onScroll();
    }

    /* ---------- Başlatma ---------- */

    function start() {
        dom.state.className = "state";
        dom.state.setAttribute("role", "status");
        dom.state.replaceChildren(el("p", { text: "Katalog yükleniyor…" }));
        dom.state.hidden = false;

        loadCatalog().then(function (catalog) {
            var index = buildIndex(catalog);
            readStateFromUrl(index);
            dom.search.value = state.query;
            renderStats(index);
            renderCollections(index);
            renderFilters(index);
            renderEmptyState();
            renderWorks(index);
            bindEvents(index);
            dom.collectionGrid.closest("section").hidden = false;
            dom.toolbar.hidden = false;
            dom.state.hidden = true;
            updateView(index);
            // Detay sayfasından "#katalog" ile dönüldüğünde, içerik yüklendikten sonra galeri başa alınır.
            if (window.location.hash === "#katalog") dom.catalog.scrollIntoView({ block: "start" });
        }).catch(function (error) {
            showError(error, start);
        });
    }

    function init() {
        dom = {
            stats: document.getElementById("intro-stats"),
            collectionGrid: document.getElementById("collection-grid"),
            catalog: document.getElementById("katalog"),
            heading: document.getElementById("katalog-baslik"),
            toolbar: document.getElementById("toolbar"),
            search: document.getElementById("search-input"),
            collectionFilter: document.getElementById("collection-filter"),
            languageFilter: document.getElementById("language-filter"),
            resultCount: document.getElementById("result-count"),
            clearButton: document.getElementById("clear-filters"),
            state: document.getElementById("catalog-state"),
            workGrid: document.getElementById("work-grid"),
            emptyState: document.getElementById("empty-state"),
            chips: function () { return Array.prototype.slice.call(document.querySelectorAll(".chip")); }
        };
        initNavigation();
        start();
    }

    init();
})();
