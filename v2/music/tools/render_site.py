"""Render locale-prefixed V2 shells and work pages from shared, validated UI messages.

Turkish source pages stay authoritative. All generated pages live only in the publication
package; catalog records, lyrics, stories, covers and media are never rewritten.
"""

import html
import json
import posixpath
import re

import render_pages

ROOT = "v2/"
# Görev 220: TR/EN/DE kabuk sayfalarının canonical, hreflang, Open Graph ve Twitter etiketleri build sırasında
# profile göre üretilir; kaynak sayfalar bu etiketleri taşımaz. og:image, hero görselinin 1200×630 türevidir.
SHELL_ROUTES = {"home": "", "catalog": "music/", "studio": "studio/"}
OG_IMAGE = {"path": "images/og/unal-digital-world-og-1200x630.jpg", "type": "image/jpeg",
            "width": "1200", "height": "630"}
SEO_TAG = re.compile(r'<link rel="(canonical|alternate)"|<meta (property="og:(?!locale")|name="twitter:)')
# Görev 221: yalnız Türkçe sayfalar (blog, gizlilik). EN/DE karşılıkları yoktur; hreflang üretilmez.
# Blog yazı sayfalarının canonical'ı Blogspot'taki orijinal adrestir (sitemap'e girmez).
BLOG_POSTS = {
    "yapay-zeka-ile-uretildi-diye-degersiz-mi": "https://unalbsungur.blogspot.com/2026/05/yapay-zeka-ile-uretildi-diye-degersiz-mi.html",
    "2026-yazinda-turkiye-turizmi": "https://unalbsungur.blogspot.com/2026/05/2026-yaznda-turkiye-turizmi-ezberler.html",
    "ne-yapayim": "https://unalbsungur.blogspot.com/2026/04/ne-yapaym.html",
}
TR_PAGES = {"v2/blog/index.html": ("blog/", None), "v2/privacy/index.html": ("privacy/", None)}
TR_PAGES.update({f"v2/blog/{slug}/index.html": (f"blog/{slug}/", url) for slug, url in BLOG_POSTS.items()})
SRCSET_ATTRIBUTE = re.compile(r'\b(?P<name>srcset|imagesrcset)="(?P<value>[^"]*)"')
SURFACES = {
    "home": ("v2/index.html", "index.html"),
    "catalog": ("v2/music/index.html", "music/index.html"),
    "work": ("v2/music/work/index.html", "music/work/index.html"),
    "studio": ("v2/studio/index.html", "studio/index.html"),
}
TEXT_NODE = re.compile(r">([^<>]+)<")
ATTRIBUTE = re.compile(r'\b(?P<name>aria-label|data-external-label|alt|placeholder)="(?P<value>[^"]*)"')
ASSET_ATTRIBUTE = re.compile(r'\b(?P<name>src|href)="(?P<value>[^"]*)"')
SELECTOR = re.compile(r'(<a data-locale="(?P<locale>tr|en|de)" href=")[^"]*"')
WORK_ID = re.compile(r"^w-\d{4}$")


class LocaleError(ValueError):
    pass


def load_messages(read):
    config = json.loads(read("v2/i18n/config.json").decode("utf-8"))
    if config.get("default") != "tr" or config.get("locales") != ["tr", "en", "de"] \
            or config.get("ogLocales") != {"tr": "tr_TR", "en": "en_US", "de": "de_DE"}:
        raise LocaleError("[I18N-CONFIG] only TR/EN/DE with Turkish fallback are supported")
    messages = {locale: json.loads(read(f"v2/i18n/{locale}.json").decode("utf-8"))
                for locale in config["locales"]}
    source = messages["tr"]
    if not isinstance(source, dict) or len(source) != len(set(source.values())):
        raise LocaleError("[I18N-KEYS] Turkish source values must be unique for controlled rendering")
    for locale, entries in messages.items():
        if set(entries) != set(source) or any(not isinstance(v, str) or not v.strip() for v in entries.values()):
            raise LocaleError(f"[I18N-KEYS] {locale}: missing, extra or blank translation")
    return config, messages


def lookup(messages, locale, key):
    """Defensive Turkish fallback for missing runtime/editorial translations."""
    return messages.get(locale, {}).get(key) or messages["tr"][key]


def localize_text(text, locale, messages):
    source = {v: key for key, v in messages["tr"].items()}

    def translated(value):
        raw = html.unescape(value)
        match = re.fullmatch(r"(\s*)(.*?)(\s*)", raw, re.DOTALL)
        normalized = " ".join(match.group(2).split())
        key = source.get(normalized)
        if key is None:
            return value
        return match.group(1) + html.escape(lookup(messages, locale, key), quote=False) + match.group(3)

    text = TEXT_NODE.sub(lambda m: ">" + translated(m.group(1)) + "<", text)
    return ATTRIBUTE.sub(lambda m: m.group("name") + '="' +
                         html.escape(html.unescape(translated(m.group("value"))), quote=True) + '"', text)


def locale_url(locale, route, profile):
    return render_pages.profile_base(profile) + (locale + "/" if locale != "tr" else "") + route


def alternates(route, profile):
    links = [(locale, locale_url(locale, route, profile)) for locale in ("tr", "en", "de")]
    links.append(("x-default", locale_url("tr", route, profile)))
    return "\n".join('    <link rel="alternate" hreflang="' + locale + '" href="' + url + '">' for locale, url in links)


def shell_seo(text, locale, surface, profile, config):
    """Canonical, hreflang (x-default = TR), Open Graph and Twitter tags of a TR/EN/DE shell page."""
    url = locale_url(locale, SHELL_ROUTES[surface], profile)
    return seo_block(text, url, profile, alternates(SHELL_ROUTES[surface], profile))


def tr_page_seo(text, rel, profile):
    """Görev 221: Turkish-only page; canonical is the page itself or, for blog posts, the original Blogspot URL."""
    route, canonical = TR_PAGES[rel]
    # Görev 222: blog yazıları og:type=article.
    return seo_block(text, canonical or locale_url("tr", route, profile), profile, None,
                     "article" if canonical else "website")


def seo_block(text, url, profile, alternate_links, og_type="website"):
    if SEO_TAG.search(text):
        raise LocaleError("[SEO-SHELL] source page already carries canonical/alternate/og/twitter tags")
    title = re.findall(r"<title>([^<]*)</title>", text)
    description = re.findall(r'<meta name="description"\s+content="([^"]*)">', text)
    if len(title) != 1 or len(description) != 1:
        raise LocaleError("[SEO-SHELL] expected one <title> and one meta description")
    title, description = html.unescape(title[0]).strip(), " ".join(html.unescape(description[0]).split())
    image = render_pages.absolute(render_pages.profile_base(profile), OG_IMAGE["path"])
    tags = [f'    <link rel="canonical" href="{html.escape(url, quote=True)}">']
    if alternate_links:
        tags.append(alternate_links)
    for prop, value in (("og:type", og_type), ("og:site_name", "Ünal Büyüksungur"), ("og:title", title),
                        ("og:description", description), ("og:url", url), ("og:image", image),
                        ("og:image:type", OG_IMAGE["type"]), ("og:image:width", OG_IMAGE["width"]),
                        ("og:image:height", OG_IMAGE["height"]), ("og:image:alt", title)):
        tags.append(f'    <meta property="{prop}" content="{html.escape(value, quote=True)}">')
    for name, value in (("twitter:card", "summary_large_image"), ("twitter:title", title),
                        ("twitter:description", description), ("twitter:image", image)):
        tags.append(f'    <meta name="{name}" content="{html.escape(value, quote=True)}">')
    anchor = re.search(r'    <meta property="og:locale" content="[a-z]{2}_[A-Z]{2}">\r?\n', text)
    if anchor is None:
        raise LocaleError("[SEO-SHELL] og:locale line not found")
    newline = "\r\n" if anchor.group(0).endswith("\r\n") else "\n"
    block = newline.join("\n".join(tags).split("\n")) + newline
    return text[:anchor.end()] + block + text[anchor.end():]


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise LocaleError(f"[I18N-TEMPLATE] expected one {old[:75]!r}, found {text.count(old)}")
    return text.replace(old, new, 1)


def relative_route(source, locale, route):
    dest = ROOT + (locale + "/" if locale != "tr" else "") + route
    rel = posixpath.relpath(dest, posixpath.dirname(source))
    if (not route or route.endswith("/")) and not rel.endswith("/"):
        rel += "/"
    return rel


def render_page(text, locale, surface, messages, config, work=None, profile="preview"):
    """Localize a source HTML document while keeping stable catalog facts and shared assets."""
    original, route = SURFACES[surface]
    seo_route = {"home": "", "catalog": "music/", "work": "music/work/", "studio": "studio/"}[surface]
    if work is not None:
        if not WORK_ID.fullmatch(work["id"]):
            raise LocaleError("[I18N-WORK] invalid work id")
        route = "music/work/" + work["id"] + ".html"
        seo_route = "music/work/" + work["id"]
    dest = ROOT + (locale + "/" if locale != "tr" else "") + route

    if locale != "tr":
        text = replace_once(text, '<html lang="tr"', f'<html lang="{locale}"')
        text = localize_text(text, locale, messages)
        if surface in ("home", "catalog", "studio"):
            description_key = {"home": "home.meta", "catalog": "music.description",
                               "studio": "studio.meta"}[surface]
            # Görev 221: the attribute may be wrapped onto the next line (\s+), which previously left it untranslated.
            text = re.sub(r'(<meta name="description"\s+content=")[^"]*(")',
                          lambda m: m[1] + html.escape(lookup(messages, locale, description_key), quote=True) + m[2],
                          text, count=1)
        if surface == "home":
            # Görev 223: "Yazılar Türkçedir." notu yalnız EN/DE ana sayfada; TR kaynakta yoktur.
            text, notes = re.subn(r'(<h2 class="section-title" id="yazilar-baslik">[^<]*</h2>\n)',
                                  lambda m: m[1] + '                <p class="section-lead lang-note">'
                                  + html.escape(lookup(messages, locale, "home.writing.note"), quote=False) + "</p>\n",
                                  text, count=1)
            if notes != 1:
                raise LocaleError("[I18N-TEMPLATE] writing heading not found")
            text = replace_once(text, "<span data-external-display>ÜNALBLOG</span>'a Git",
                                (("Visit " if locale == "en" else "Zum ") +
                                 "<span data-external-display>ÜNALBLOG</span>"))
        if surface == "work" and work is not None:
            title = html.escape(work["title"], quote=True)
            name = "My Music" if locale == "en" else "Meine Musik"
            text = replace_once(text, f"{title} | Müzik Dünyam | Ünal Büyüksungur",
                                f"{title} | {name} | Ünal Büyüksungur")
            language = {"tr": ("Turkish", "türkisches"), "de": ("German", "deutsches")}[work["language"]]
            if locale == "en":
                description = f"{work['title']} is a {language[0]} work by Ünal Büyüksungur. Explore its original lyrics, story and music video."
            else:
                description = f"{work['title']} ist ein {language[1]} Werk von Ünal Büyüksungur. Originaltext, Geschichte und Musikvideo entdecken."
            for attr in ('name="description"', 'property="og:description"', 'name="twitter:description"'):
                pattern = r'(<meta ' + attr + r' content=")[^"]*(")'
                text, n = re.subn(pattern, lambda m: m[1] + html.escape(description, quote=True) + m[2], text)
                if n != 1:
                    raise LocaleError("[I18N-META] missing " + attr)
        text = replace_once(text, 'property="og:locale" content="tr_TR"',
                            'property="og:locale" content="' + config["ogLocales"][locale] + '"')
        old_canonical = locale_url("tr", seo_route, profile)
        new_canonical = locale_url(locale, seo_route, profile)
        if work is not None:
            text = replace_once(text, 'rel="canonical" href="' + old_canonical + '"',
                                'rel="canonical" href="' + new_canonical + '"')
            text = replace_once(text, 'property="og:url" content="' + old_canonical + '"',
                                'property="og:url" content="' + new_canonical + '"')
        elif surface == "work":
            text = replace_once(text, "Eser | Müzik Dünyam | Ünal Büyüksungur",
                                ("Work | My Music" if locale == "en" else "Werk | Meine Musik") + " | Ünal Büyüksungur")
        # Görev 221: blog/ and privacy/ are Turkish-only pages; EN/DE pages link to the Turkish ones.
        changes = {
            "home": {"images/": "../images/", "external-links.js": "../external-links.js",
                     "i18n/": "../i18n/", "blog/": "../blog/", "privacy/": "../privacy/"},
            "catalog": {"catalog.css": "../../music/catalog.css", "catalog.js": "../../music/catalog.js",
                        "../images/": "../../images/", "../external-links.js": "../../external-links.js",
                        "../i18n/": "../../i18n/", "../privacy/": "../../privacy/"},
            "work": {"../catalog.css": "../../../music/catalog.css", "work.css": "../../../music/work/work.css",
                      "work.js": "../../../music/work/work.js", "../../external-links.js": "../../../external-links.js",
                      "../../images/": "../../../images/", "../../i18n/": "../../../i18n/",
                      "../../privacy/": "../../../privacy/"},
            "studio": {"../music/catalog.css": "../../music/catalog.css",
                       "studio.css": "../../studio/studio.css", "../images/": "../../images/",
                       "../i18n/": "../../i18n/", "../privacy/": "../../privacy/",
                       "../external-links.js": "../../external-links.js"},
        }[surface]

        def asset(m):
            value = m.group("value")
            if m.group("name") == "href" and (value.startswith("#") or value.startswith("http")):
                return m.group(0)
            for start, replacement in changes.items():
                if value.startswith(start):
                    return m.group("name") + '="' + replacement + value[len(start):] + '"'
            return m.group(0)

        text = ASSET_ATTRIBUTE.sub(asset, text)

        # Görev 220: responsive image candidates (srcset/imagesrcset) follow the same shared-asset rewrite.
        def candidates(m):
            rewritten = []
            for candidate in m.group("value").split(","):
                parts = candidate.strip().split()
                if not parts:
                    raise LocaleError("[I18N-SRCSET] empty image candidate")
                inner = ASSET_ATTRIBUTE.match('src="' + parts[0] + '"')
                parts[0] = asset(inner)[len('src="'):-1]
                rewritten.append(" ".join(parts))
            return m.group("name") + '="' + ", ".join(rewritten) + '"'

        text = SRCSET_ATTRIBUTE.sub(candidates, text)
        # The shared music assets are loaded from the root music/ folder; navigation stays within the locale.
        if surface == "work":
            script = '<script>window.UNAL_MESSAGES=' + json.dumps(messages[locale], ensure_ascii=True,
                                                                  separators=(",", ":")) + ';</script>'
            text = replace_once(text, '</head>', script + '\n</head>')
        elif surface == "catalog":
            script = '<script>window.UNAL_MESSAGES=' + json.dumps(messages[locale], ensure_ascii=True,
                                                                  separators=(",", ":")) + ';</script>'
            text = replace_once(text, '</head>', script + '\n</head>')

    # Selector hrefs are actual static alternatives even when JavaScript is unavailable.
    def switch(m):
        target = m.group("locale")
        link = relative_route(dest, target, route if work is not None else seo_route)
        return m.group(1) + link + '"'

    text, count = SELECTOR.subn(switch, text)
    if count != 3:
        raise LocaleError("[I18N-SELECTOR] expected TR/EN/DE links")
    text = re.sub(r'(<a data-locale="(tr|en|de)"[^>]*?) aria-current="true"', r'\1', text)
    text = re.sub(r'(<a data-locale="' + locale + r'"[^>]*)(>)', r'\1 aria-current="true"\2', text, count=1)
    if work is not None:
        canonical = locale_url(locale, seo_route, profile)
        text = replace_once(text, f'<link rel="canonical" href="{canonical}">',
                            f'<link rel="canonical" href="{canonical}">\n' + alternates(seo_route, profile))
    if surface in SHELL_ROUTES:
        text = shell_seo(text, locale, surface, profile, config)
    return text.encode("utf-8")


def render(catalog, sources, profile="preview"):
    if profile not in render_pages.PROFILES:
        raise LocaleError(f"[I18N-PROFILE] unknown profile: {profile!r}")
    config, messages = load_messages(lambda rel: sources[rel])
    tr_pages = render_pages.render_work_pages(catalog, sources[SURFACES["work"][0]], profile)
    works = {w["id"]: w for w in catalog["works"]}
    pages = {}
    for path, data in tr_pages.items():
        work = works[path.rsplit("/", 1)[-1][:-5]]
        pages[path] = render_page(data.decode("utf-8"), "tr", "work", messages, config, work, profile)
        for locale in ("en", "de"):
            pages[path.replace("v2/music/", "v2/" + locale + "/music/", 1)] = render_page(
                data.decode("utf-8"), locale, "work", messages, config, work, profile)
    # Görev 220: Turkish shells are rendered too, so every shell carries profile-specific SEO tags.
    for surface in SHELL_ROUTES:
        source = SURFACES[surface][0]
        pages[source] = render_page(sources[source].decode("utf-8"), "tr", surface, messages, config,
                                    profile=profile)
    for locale in ("en", "de"):
        for surface, (source, route) in SURFACES.items():
            pages["v2/" + locale + "/" + route] = render_page(
                sources[source].decode("utf-8"), locale, surface, messages, config, profile=profile)
    for rel in TR_PAGES:
        pages[rel] = tr_page_seo(sources[rel].decode("utf-8"), rel, profile).encode("utf-8")
    return pages
