"""Render locale-prefixed V2 shells and work pages from shared, validated UI messages.

Turkish source pages stay authoritative. All generated pages live only in the publication
package; catalog records, lyrics, stories, covers and media are never rewritten.
"""

import html
import json
import posixpath
import re

import render_pages

ORIGIN = "https://unalbuyuksungur-v2.pages.dev"
ROOT = "v2/"
SURFACES = {
    "home": ("v2/index.html", "index.html"),
    "catalog": ("v2/music/index.html", "music/index.html"),
    "work": ("v2/music/work/index.html", "music/work/index.html"),
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


def locale_url(locale, route):
    return ORIGIN + "/v2/" + (locale + "/" if locale != "tr" else "") + route


def alternates(route):
    return "\n".join('    <link rel="alternate" hreflang="' + locale + '" href="' + locale_url(locale, route) + '">'
                     for locale in ("tr", "en", "de"))


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


def render_page(text, locale, surface, messages, config, work=None, catalog=None):
    """Localize a source HTML document while keeping stable catalog facts and shared assets."""
    original, route = SURFACES[surface]
    seo_route = {"home": "", "catalog": "music/", "work": "music/work/"}[surface]
    if work is not None:
        if not WORK_ID.fullmatch(work["id"]):
            raise LocaleError("[I18N-WORK] invalid work id")
        route = "music/work/" + work["id"] + ".html"
        seo_route = "music/work/" + work["id"]
    dest = ROOT + (locale + "/" if locale != "tr" else "") + route

    if locale != "tr":
        text = replace_once(text, '<html lang="tr"', f'<html lang="{locale}"')
        text = localize_text(text, locale, messages)
        if surface in ("home", "catalog"):
            description_key = "home.meta" if surface == "home" else "music.description"
            text = re.sub(r'(<meta name="description" content=")[^"]*(")',
                          lambda m: m[1] + html.escape(lookup(messages, locale, description_key), quote=True) + m[2],
                          text, count=1)
        if surface == "home":
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
        old_canonical = locale_url("tr", seo_route)
        new_canonical = locale_url(locale, seo_route)
        if surface != "work" or work is not None:
            text = replace_once(text, 'rel="canonical" href="' + old_canonical + '"',
                                'rel="canonical" href="' + new_canonical + '"')
        if work is not None:
            text = replace_once(text, 'property="og:url" content="' + old_canonical + '"',
                                'property="og:url" content="' + new_canonical + '"')
        elif surface == "work":
            text = replace_once(text, "Eser | Müzik Dünyam | Ünal Büyüksungur",
                                ("Work | My Music" if locale == "en" else "Werk | Meine Musik") + " | Ünal Büyüksungur")
        changes = {
            "home": {"images/": "../images/", "external-links.js": "../external-links.js",
                     "i18n/": "../i18n/"},
            "catalog": {"catalog.css": "../../music/catalog.css", "catalog.js": "../../music/catalog.js",
                        "../images/": "../../images/", "../external-links.js": "../../external-links.js",
                        "../i18n/": "../../i18n/"},
            "work": {"../catalog.css": "../../../music/catalog.css", "work.css": "../../../music/work/work.css",
                      "work.js": "../../../music/work/work.js", "../../external-links.js": "../../../external-links.js",
                      "../../images/": "../../../images/", "../../i18n/": "../../../i18n/"},
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
        # The shared music assets are loaded from /v2/music/; navigation stays within the locale.
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
        canonical = locale_url(locale, seo_route)
        text = replace_once(text, f'<link rel="canonical" href="{canonical}">',
                            f'<link rel="canonical" href="{canonical}">\n' + alternates(seo_route))
    return text.encode("utf-8")


def render(catalog, sources, profile="preview"):
    if profile != "preview":
        raise LocaleError("[I18N-PROFILE] only noindexed preview is supported")
    config, messages = load_messages(lambda rel: sources[rel])
    tr_pages = render_pages.render_work_pages(catalog, sources[SURFACES["work"][0]], profile)
    works = {w["id"]: w for w in catalog["works"]}
    pages = {}
    for path, data in tr_pages.items():
        work = works[path.rsplit("/", 1)[-1][:-5]]
        pages[path] = render_page(data.decode("utf-8"), "tr", "work", messages, config, work)
        for locale in ("en", "de"):
            pages[path.replace("v2/music/", "v2/" + locale + "/music/", 1)] = render_page(
                data.decode("utf-8"), locale, "work", messages, config, work)
    for locale in ("en", "de"):
        for surface, (source, route) in SURFACES.items():
            pages["v2/" + locale + "/" + route] = render_page(
                sources[source].decode("utf-8"), locale, surface, messages, config)
    return pages
