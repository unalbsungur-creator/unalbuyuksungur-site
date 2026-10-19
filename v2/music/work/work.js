/* Ünal Büyüksungur — Müzik Dünyam eser detay sayfası
   Tek şablon: work/?id=w-0001. Veri kaynağı: ../data/catalog.json. Framework yok, derleme adımı yok. */
(function () {
    "use strict";

    var CATALOG_URL = "../data/catalog.json";
    // Katalogdaki göreli yollar (webImages.path, lyrics.file, story.file) v2/music/ klasörüne göredir.
    var MUSIC_ROOT = "../";
    // Yayımlanmış söz/hikâye dosyası yolu: yalnızca bu kalıp kabul edilir (mutlak yol, URL, ../ yok).
    var CONTENT_PATH = /^content\/(lyrics|stories)\/[wr]-\d{4}\.txt$/;
    var WORK_ID = /^w-\d{4}$/;
    var MAX_QUERY_LENGTH = 100;
    var SITE_NAME = "Ünal Büyüksungur";
    var LANGUAGE_NAMES = { tr: "Türkçe", de: "Almanca" };
    var GENRE_NAMES = { pop: "Pop", "rock-ballad": "Rock Ballad", "thrash-metal": "Thrash Metal" };
    var DATE_RANGE_NOTES = {
        "cover-verified": "Kapak üzerindeki tarih; henüz doğrulanmadı.",
        conflict: "Kapak üzerindeki tarih; komşu burçla çakıştığı için doğrulama bekliyor.",
        unverified: "Henüz doğrulanmadı."
    };
    // Başlığında sürüm adı geçmeyen kayıtlar için arayüz etiketi (Word arşivindeki bölüm başlıkları
    // 55 "Akustik", 56 "Rock'n Roll"). Katalogdaki title/versionLabel/genres değiştirilmez.
    var VERSION_TAGS = { "r-0051": "Akustik", "r-0021": "Rock'n Roll" };
    var LISTEN_PLATFORMS = [
        { key: "spotify", name: "Spotify'da Dinle" },
        { key: "appleMusic", name: "Apple Music'te Dinle" },
        { key: "youtubeMusic", name: "YouTube Music'te Dinle" },
        { key: "youtube", name: "YouTube'da Dinle" }
    ];
    var TEXTS = {
        lyrics: {
            empty: "Bu eserin şarkı sözleri henüz yayımlanmadı.",
            error: "Şarkı sözleri şu anda yüklenemedi. Lütfen daha sonra yeniden deneyin."
        },
        story: {
            empty: "Bu eserin hikâyesi yakında burada yer alacak.",
            error: "Hikâye şu anda yüklenemedi. Lütfen daha sonra yeniden deneyin."
        },
        listenEmpty: "Dinleme bağlantıları yakında eklenecek."
    };
    // Kapak çerçevesi: masaüstünde sol sütun (en fazla ~560px), mobilde tam genişlik
    var HERO_SIZES = "(min-width: 1320px) 560px, (min-width: 900px) 42vw, (min-width: 600px) 560px, calc(100vw - 40px)";

    var collator = new Intl.Collator("tr", { sensitivity: "base", numeric: true });
    var dom = {};

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

    function languageName(code) {
        return LANGUAGE_NAMES[code] || String(code).toUpperCase();
    }

    function absoluteUrl(path) {
        return new URL(path, window.location.href).href;
    }

    // Doğrulayıcının (kontrol 34) tarayıcıdaki karşılığı: https, ana bilgisayar adı var, kullanıcı bilgisi ve boşluk yok.
    function isHttpsUrl(value) {
        if (typeof value !== "string" || !/^https:\/\/[^\s]+$/.test(value)) return false;
        try {
            var url = new URL(value);
            return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
        } catch (error) {
            return false;
        }
    }

    /* ---------- Görseller ---------- */

    // SHA-256'nın ilk 12 karakteri önbellek sürümü olarak eklenir (katalogla aynı kural).
    function imageUrl(image) {
        return MUSIC_ROOT + image.path + "?v=" + image.sha256.slice(0, 12);
    }

    function sortedImages(cover) {
        return cover.webImages.slice().sort(function (a, b) { return a.width - b.width; });
    }

    function largestImage(cover) {
        var images = sortedImages(cover);
        return images[images.length - 1];
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
            fetchpriority: options.priority ? "high" : null,
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

    function workTitle(work) {
        return work.title || work.workingTitle || work.id;
    }

    // Kataloğun (catalog.js) eser modeliyle aynı kurallar: onaylı ilk kayıt başta, sonra kayıt kimliği.
    function resolveWork(catalog, workId) {
        var works = byId(catalog.works);
        var work = works[workId];
        if (!work) return null;
        var covers = byId(catalog.covers);
        var recordings = catalog.recordings.filter(function (r) { return r.workId === workId; }).sort(function (a, b) {
            return (b.isOriginal === true) - (a.isOriginal === true) || collator.compare(a.id, b.id);
        });
        if (!recordings.length) return null;

        var collections = [];
        catalog.collections.slice().sort(function (a, b) { return a.order - b.order; }).forEach(function (collection) {
            collection.members.forEach(function (member) {
                if (member.workId === workId) collections.push({ collection: collection, dateRange: member.dateRange || null });
            });
        });

        // 'adaptation' ilişkisi yönsüzdür; yalnızca katalogdaki relations kayıtlarından okunur.
        var related = [];
        catalog.relations.forEach(function (relation) {
            var other = relation.source === workId ? relation.target : relation.target === workId ? relation.source : null;
            if (!other || !works[other]) return;
            var otherRecordings = catalog.recordings.filter(function (r) { return r.workId === other; }).sort(function (a, b) {
                return (b.isOriginal === true) - (a.isOriginal === true) || collator.compare(a.id, b.id);
            });
            related.push({ type: relation.type, work: works[other], cover: covers[otherRecordings[0].coverId] });
        });
        related.sort(function (a, b) { return collator.compare(workTitle(a.work), workTitle(b.work)); });

        return {
            data: work,
            id: work.id,
            title: workTitle(work),
            titleConfirmed: work.titleStatus === "confirmed",
            recordings: recordings,
            covers: covers,
            collections: collections,
            related: related
        };
    }

    /* ---------- Kataloğa dönüş durumu ---------- */

    // Katalog filtreleri (q, koleksiyon, dil) URL ile taşınır; yalnızca katalogda var olan değerler kabul edilir.
    function readReturnState(catalog) {
        var params = new URLSearchParams(window.location.search);
        var result = new URLSearchParams();
        var query = (params.get("q") || "").trim().slice(0, MAX_QUERY_LENGTH);
        var collection = params.get("koleksiyon") || "";
        var language = params.get("dil") || "";
        if (query) result.set("q", query);
        if (catalog.collections.some(function (c) { return c.slug === collection; })) result.set("koleksiyon", collection);
        if (catalog.works.some(function (w) { return w.language === language; })) result.set("dil", language);
        return result;
    }

    function catalogHref(returnState) {
        var search = returnState.toString();
        return MUSIC_ROOT + (search ? "?" + search : "") + "#katalog";
    }

    // id ilk sırada kalır: ./?id=w-0001&koleksiyon=...
    function workHref(workId, returnState) {
        var rest = returnState.toString();
        return "./?id=" + encodeURIComponent(workId) + (rest ? "&" + rest : "");
    }

    /* ---------- SEO ve paylaşım ---------- */

    function setMeta(attribute, name, content) {
        var node = document.head.querySelector("meta[" + attribute + '="' + name + '"]');
        if (!node) {
            node = el("meta", {});
            node.setAttribute(attribute, name);
            document.head.appendChild(node);
        }
        node.setAttribute("content", content);
    }

    function setCanonical(href) {
        var node = document.head.querySelector('link[rel="canonical"]');
        if (!node) {
            node = el("link", { rel: "canonical" });
            document.head.appendChild(node);
        }
        node.setAttribute("href", href);
    }

    function describe(work) {
        var parts = [SITE_NAME + "'un " + languageName(work.data.language) + " eseri “" + work.title + "”."];
        if (work.collections.length) {
            parts.push(work.collections.map(function (m) { return m.collection.title; }).join(", ") + " koleksiyonunda.");
        }
        if (work.recordings.length > 1) {
            var genres = [];
            work.recordings.forEach(function (r) {
                r.genres.forEach(function (g) {
                    var name = GENRE_NAMES[g] || g;
                    if (genres.indexOf(name) === -1) genres.push(name);
                });
            });
            parts.push(work.recordings.length + " kayıt versiyonu" + (genres.length > 1 ? ": " + genres.join(", ") + "." : "."));
        }
        return parts.join(" ");
    }

    function applySeo(work) {
        var title = work.title + " | Müzik Dünyam | " + SITE_NAME;
        var description = describe(work);
        var canonical = absoluteUrl("./?id=" + encodeURIComponent(work.id));
        var cover = work.covers[work.recordings[0].coverId];
        var image = largestImage(cover);

        document.title = title;
        setMeta("name", "description", description);
        setCanonical(canonical);
        setMeta("property", "og:title", work.title + " | " + SITE_NAME);
        setMeta("property", "og:description", description);
        setMeta("property", "og:url", canonical);
        setMeta("property", "og:image", absoluteUrl(imageUrl(image)));
        setMeta("property", "og:image:width", String(image.width));
        setMeta("property", "og:image:height", String(image.height));
        setMeta("property", "og:image:alt", work.title + " kapak görseli");
    }

    /* ---------- Çizim ---------- */

    function genreTags(recording) {
        var tags = recording.genres.map(function (genre) {
            return el("span", { className: "tag", text: GENRE_NAMES[genre] || genre });
        });
        if (VERSION_TAGS[recording.id]) tags.unshift(el("span", { className: "tag", text: VERSION_TAGS[recording.id] }));
        return tags;
    }

    // İlk/alternatif etiketi yalnızca isOriginal doğrulanmışsa (true/false) gösterilir.
    function originTag(recording) {
        if (recording.isOriginal === true) return el("span", { className: "tag tag--gold", text: "İlk kayıt" });
        if (recording.isOriginal === false) return el("span", { className: "tag", text: "Alternatif kayıt" });
        return null;
    }

    function renderFacts(work) {
        var facts = [];
        function fact(term, children) {
            facts.push(el("div", { className: "work-fact" }, [el("dt", { text: term }), el("dd", {}, children)]));
        }
        fact("Dil", [languageName(work.data.language)]);
        work.collections.forEach(function (m) {
            fact("Koleksiyon", [el("a", {
                href: catalogHref(new URLSearchParams({ koleksiyon: m.collection.slug })),
                text: m.collection.title
            })]);
            if (m.dateRange) {
                fact("Tarih aralığı", [
                    m.dateRange.label,
                    el("small", { text: DATE_RANGE_NOTES[m.dateRange.status] || DATE_RANGE_NOTES.unverified })
                ]);
            }
        });
        var count = work.recordings.length;
        fact("Kayıt", [count > 1 ? count + " versiyon" : "1 kayıt"]);
        dom.facts.replaceChildren.apply(dom.facts, facts);
    }

    function renderVersions(work, selectedId) {
        var multiple = work.recordings.length > 1;
        var children = [];
        if (!multiple) {
            var only = work.recordings[0];
            var tags = genreTags(only);
            children.push(el("h2", { className: "versions-title", text: "Kayıt" }));
            children.push(el("div", { className: "version-card version-card--static" }, [
                el("span", { className: "version-text" }, [
                    el("span", { className: "version-name", text: only.title }),
                    tags.length ? el("span", { className: "version-tags" }, tags) : null
                ])
            ]));
        } else {
            var options = work.recordings.map(function (recording) {
                var tags = genreTags(recording);
                var origin = originTag(recording);
                if (origin) tags.push(origin);
                var input = el("input", {
                    type: "radio",
                    name: "version",
                    value: recording.id,
                    id: "version-" + recording.id,
                    className: "version-input",
                    checked: recording.id === selectedId
                });
                return el("li", {}, [
                    input,
                    el("label", { className: "version-card", for: input.id }, [
                        coverImage(work.covers[recording.coverId], { minWidth: 400, sizes: "64px", alt: "", lazy: false }),
                        el("span", { className: "version-text" }, [
                            el("span", { className: "version-name", text: recording.title }),
                            tags.length ? el("span", { className: "version-tags" }, tags) : null
                        ]),
                        el("span", { className: "version-check", "aria-hidden": "true" })
                    ])
                ]);
            });
            var fieldset = el("fieldset", { className: "versions" }, [
                el("legend", { className: "versions-title", text: work.recordings.length + " Versiyon" }),
                el("p", { className: "versions-hint", text: "Kapağı ve kayıt bilgilerini görmek için bir versiyon seçin." }),
                el("ul", { className: "version-list" }, options)
            ]);
            children.push(fieldset);
            if (!work.recordings.some(function (r) { return r.isOriginal === true; })) {
                children.push(el("p", { className: "work-note", text: "Hangi kaydın ilk/orijinal versiyon olduğu henüz belirlenmedi." }));
            }
        }
        dom.versions.replaceChildren.apply(dom.versions, children);
    }

    function renderCover(work, recording) {
        var cover = work.covers[recording.coverId];
        var image = coverImage(cover, { minWidth: 1200, sizes: HERO_SIZES, alt: recording.title + " kapak görseli", lazy: false, priority: true });
        dom.frame.replaceChildren(image);
        // Alt yazı yalnızca birden fazla versiyonda seçili kaydı gösterir; tek kayıtta bilgi zaten yanda yazılı.
        dom.caption.hidden = work.recordings.length < 2;
        if (dom.caption.hidden) return;
        var tags = genreTags(recording);
        var origin = originTag(recording);
        if (origin) tags.push(origin);
        dom.caption.replaceChildren.apply(dom.caption, [
            el("span", { className: "work-caption-label", text: "Seçili versiyon" }),
            el("span", { className: "work-caption-title", text: recording.title })
        ].concat(tags.length ? [el("span", { className: "version-tags" }, tags)] : []));
    }

    // Şarkı sözü ve hikâye modülü. Yayın kuralları (bkz. data/README.md):
    //   missing / draft  -> boş durum metni; dosya istenmez.
    //   published        -> yalnızca content/{lyrics|stories}/<kimlik>.txt yolundaki UTF-8 düz metin.
    //   yüklenemeyen, geçersiz yollu ya da boş dosya -> anlaşılır hata metni.
    // Metin HTML olarak yorumlanmaz; boş satırlar kıta/paragraf, tek satır sonları <br> olur.
    function renderText(target, asset, texts, className) {
        var token = {};
        target.__request = token;
        function note(text) {
            target.replaceChildren(el("p", { className: "empty-note", text: text }));
        }
        if (!asset || asset.status !== "published") {
            note(texts.empty);
            return;
        }
        if (typeof asset.file !== "string" || !CONTENT_PATH.test(asset.file)) {
            note(texts.error);
            return;
        }
        note("Yükleniyor…");
        fetch(MUSIC_ROOT + asset.file, { cache: "no-cache" }).then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.arrayBuffer();
        }).then(function (buffer) {
            if (target.__request !== token) return; // daha yeni bir istek var (versiyon değişti)
            // Geçersiz UTF-8 sessizce "�" karakterine dönüşmesin; hata durumu gösterilir.
            var text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/\r\n?/g, "\n").trim();
            if (!text) throw new Error("boş içerik");
            target.replaceChildren(el("div", { className: className }, text.split(/\n[ \t]*\n/).map(function (block) {
                var p = el("p", {});
                block.split("\n").forEach(function (line, i) {
                    if (i) p.appendChild(el("br", {}));
                    p.appendChild(document.createTextNode(line));
                });
                return p;
            })));
        }).catch(function () {
            if (target.__request === token) note(texts.error);
        });
    }

    // Sözler eserindir; bir kaydın sözleri farklıysa yalnızca o kayıtta yayımlanmış istisna kullanılır.
    function lyricsFor(work, recording) {
        return recording.lyrics && recording.lyrics.status === "published" ? recording.lyrics : work.data.lyrics;
    }

    // Yalnızca katalogda kayıtlı, https ile başlayan bağlantılar gösterilir.
    function renderListen(work, recording) {
        var links = [];
        LISTEN_PLATFORMS.forEach(function (platform) {
            var url = recording.links[platform.key];
            if (isHttpsUrl(url)) links.push({ name: platform.name, url: url });
        });
        (recording.links.other || []).forEach(function (link) {
            if (isHttpsUrl(link.url) && link.platform) links.push({ name: link.platform, url: link.url });
        });
        if (!links.length) {
            dom.listen.replaceChildren(el("p", { className: "empty-note", text: TEXTS.listenEmpty }));
            return;
        }
        var children = [];
        if (work.recordings.length > 1) children.push(el("p", { className: "listen-for", text: recording.title }));
        children.push(el("ul", { className: "listen-links" }, links.map(function (link) {
            return el("li", {}, [el("a", {
                className: "button button-secondary",
                href: link.url,
                target: "_blank",
                rel: "noopener noreferrer",
                text: link.name
            }, [el("span", { className: "visually-hidden", text: " (yeni sekmede açılır)" })])]);
        })));
        dom.listen.replaceChildren.apply(dom.listen, children);
    }

    function renderRelated(work, returnState) {
        if (!work.related.length) {
            dom.relatedSection.hidden = true;
            return;
        }
        dom.related.replaceChildren.apply(dom.related, work.related.map(function (relation) {
            var title = workTitle(relation.work);
            return el("li", {}, [el("a", { className: "related-work", href: workHref(relation.work.id, returnState) }, [
                coverImage(relation.cover, { minWidth: 400, sizes: "96px", alt: "", lazy: true }),
                el("span", { className: "related-text" }, [
                    el("span", { className: "related-kind", text: relation.type === "adaptation" ? "Dil uyarlaması" : "İlişkili eser" }),
                    el("span", { className: "related-title", text: title }),
                    el("span", { className: "related-lang", text: languageName(relation.work.language) })
                ])
            ])]);
        }));
        dom.relatedSection.hidden = false;
    }

    /* ---------- Versiyon seçimi ---------- */

    function selectRecording(work, recordingId, updateUrl) {
        var recording = work.recordings.filter(function (r) { return r.id === recordingId; })[0] || work.recordings[0];
        renderCover(work, recording);
        renderListen(work, recording);
        var lyrics = lyricsFor(work, recording);
        if (lyrics !== dom.lyrics.__asset) {
            dom.lyrics.__asset = lyrics;
            renderText(dom.lyrics, lyrics, TEXTS.lyrics, "lyrics");
        }
        if (updateUrl && work.recordings.length > 1) {
            var params = new URLSearchParams(window.location.search);
            if (recording.id === work.recordings[0].id) params.delete("kayit");
            else params.set("kayit", recording.id);
            var search = params.toString();
            window.history.replaceState(null, "", window.location.pathname + (search ? "?" + search : "") + window.location.hash);
        }
        return recording;
    }

    /* ---------- Hata durumu ---------- */

    function showError(title, text, retry, detail) {
        document.title = title + " | Müzik Dünyam | " + SITE_NAME;
        setMeta("name", "robots", "noindex");
        var actions = [el("a", { className: "button button-primary", href: "../#katalog", text: "Tüm Eserleri Keşfet" })];
        if (retry) {
            var button = el("button", { className: "button button-secondary", type: "button", text: "Yeniden dene" });
            button.addEventListener("click", retry);
            actions.unshift(button);
        }
        dom.state.className = "work-state work-state--error";
        dom.state.setAttribute("role", "alert");
        var children = [
            el("p", { className: "eyebrow", text: "MÜZİK / ESER" }),
            el("h1", { className: "work-state-title", text: title }),
            el("p", { text: text })
        ];
        if (detail) children.push(el("p", { className: "visually-hidden", text: "Teknik ayrıntı: " + detail }));
        children.push(el("div", { className: "work-state-actions" }, actions));
        dom.state.replaceChildren.apply(dom.state, children);
        dom.state.hidden = false;
        dom.work.hidden = true;
    }

    /* ---------- Başlatma ---------- */

    function render(catalog) {
        var params = new URLSearchParams(window.location.search);
        var workId = (params.get("id") || "").trim();
        if (!workId) {
            showError("Eser seçilmedi.", "Bu sayfa bir eser kimliğiyle açılmalıdır. Kataloğa dönüp bir eser seçebilirsiniz.");
            return;
        }
        // Eski birleşik eser bağlantıları (ör. ?id=w-0020&kayit=r-0021): kayıt artık kendi eserindeyse oraya yönlendirilir.
        var requested = params.get("kayit");
        var moved = catalog.recordings.filter(function (r) { return r.id === requested; })[0];
        if (moved && moved.workId !== workId && WORK_ID.test(workId)) {
            params.set("id", moved.workId);
            params.delete("kayit");
            window.location.replace(window.location.pathname + "?" + params.toString() + window.location.hash);
            return;
        }
        var work = WORK_ID.test(workId) ? resolveWork(catalog, workId) : null;
        if (!work) {
            showError("Eser bulunamadı.", "“" + workId.slice(0, 40) + "” kimliğiyle kayıtlı bir eser yok. Bağlantı eksik ya da hatalı olabilir.");
            return;
        }

        var returnState = readReturnState(catalog);
        var hasReturnState = Boolean(returnState.toString());

        applySeo(work);
        dom.title.textContent = work.title;
        dom.crumbTitle.textContent = work.title;
        dom.crumbCatalog.setAttribute("href", catalogHref(returnState));
        if (!work.titleConfirmed) {
            dom.titleNote.textContent = "Bu eserin kesin başlığı henüz belirlenmedi; şimdilik iki kaydın adıyla birlikte gösteriliyor.";
            dom.titleNote.hidden = false;
        }
        renderFacts(work);

        var selected = work.recordings.filter(function (r) { return r.id === requested; })[0] || work.recordings[0];
        renderVersions(work, selected.id);
        selectRecording(work, selected.id, false);

        renderText(dom.story, work.data.story, TEXTS.story, "story");
        renderRelated(work, returnState);

        if (hasReturnState) {
            dom.ctaBack.setAttribute("href", catalogHref(returnState));
            dom.ctaBack.hidden = false;
        }

        dom.versions.addEventListener("change", function (event) {
            if (event.target.name === "version") selectRecording(work, event.target.value, true);
        });

        dom.state.hidden = true;
        dom.work.hidden = false;
    }

    function start() {
        dom.state.className = "work-state";
        dom.state.setAttribute("role", "status");
        dom.state.replaceChildren(el("p", { text: "Eser yükleniyor…" }));
        dom.state.hidden = false;

        loadCatalog().then(render).catch(function (error) {
            var hint = window.location.protocol === "file:"
                ? "Sayfa doğrudan dosya olarak açılmış görünüyor. Tarayıcılar bu durumda katalog verisinin yüklenmesine izin vermez; sayfayı bir yerel HTTP sunucusu üzerinden açın."
                : "Bağlantınızı kontrol edip yeniden deneyebilirsiniz.";
            showError("Katalog yüklenemedi.", hint, start, error.message);
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

    function init() {
        dom = {
            state: document.getElementById("work-state"),
            work: document.getElementById("work"),
            frame: document.getElementById("work-frame"),
            caption: document.getElementById("work-caption"),
            title: document.getElementById("work-title"),
            titleNote: document.getElementById("work-title-note"),
            crumbTitle: document.getElementById("crumb-title"),
            crumbCatalog: document.getElementById("crumb-catalog"),
            facts: document.getElementById("work-facts"),
            versions: document.getElementById("work-versions"),
            lyrics: document.getElementById("work-lyrics"),
            story: document.getElementById("work-story"),
            listen: document.getElementById("work-listen"),
            related: document.getElementById("work-related"),
            relatedSection: document.getElementById("work-related-section"),
            ctaBack: document.getElementById("cta-back")
        };
        initNavigation();
        start();
    }

    init();
})();
