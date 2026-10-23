#!/usr/bin/env python3
"""V2 statik eser sayfası oluşturucu (Görev 73; yalnızca yayın paketinde kullanılır, depoya dosya yazmaz).

Her eser için v2/music/work/w-0001.html … üretilir. Sayfa, eser şablonunun (v2/music/work/index.html)
kendisidir; yalnızca head içindeki varsayılan metadata bölgesi eserin statik metadata'sıyla değiştirilir ve
<html> etiketine data-work-id eklenir. Gövde, stil ve betik yolları şablonla bayt bayt aynı kalır; dosya aynı
klasörde olduğu için göreli yollar değişmez. Cloudflare Pages w-0001.html dosyasını /v2/music/work/w-0001
adresinde sunar.

Metadata yalnızca katalogdaki bilgilerden üretilir (başlık, dil, koleksiyon, yayımlanmış söz/hikâye, video,
kapak). Tarih, tür ve orijinallik yazılmaz. Bütün değerler escape edilir; eksik ya da şüpheli veride
RenderError ile durulur (kısmi çıktı yok). Çıktı belirlenimcidir: zaman damgası, ortam değişkeni yoktur.

Yalnızca preview profili tanımlıdır; production (ana alan adı) bu görevde bilerek yoktur.
"""

import html
import re
from urllib.parse import urlsplit

TEMPLATE = "v2/music/work/index.html"
OUTPUT_DIR = "v2/music/work/"
SITE_NAME = "Ünal Büyüksungur"

# Ortam profili: mutlak metadata URL'lerinin kökü. Yeni profil bilinçli olarak eklenmeli (ör. production).
PROFILES = {
    "preview": {"origin": "https://unalbuyuksungur-v2.pages.dev", "prefix": "/v2/"},
}

LANGUAGE_NAMES = {"tr": "Türkçe", "de": "Almanca"}  # work.js ile aynı
IMAGE_TYPES = {"webp": "image/webp", "jpeg": "image/jpeg", "png": "image/png"}
WORK_ID = re.compile(r"^w-\d{4}$")
COVER_ID = re.compile(r"^c-\d{4}$")
IMAGE_PATH = re.compile(r"^images/c-\d{4}-(400|800|1200)\.webp$")  # build_publication.py ile aynı kalıp
SHA256 = re.compile(r"^[0-9a-f]{64}$")
ORIGIN = re.compile(r"^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
PREFIX = re.compile(r"^/([a-z0-9-]+/)*$")
CONTROL = re.compile(r"[\x00-\x1f\x7f]")
YOUTUBE_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")  # work.js VIDEO_PROVIDERS ile aynı
VIDEO_TYPES = {"official-music-video"}
MAX_TEXT = 200

# Şablondaki varsayılan metadata bölgesi: <title> satırı ve hemen çevresindeki yorum/description/og satırları.
REGION_LINE = re.compile(
    r'^\s*(<!--.*-->|<title>[^<]*</title>|<meta name="description" content="[^"]*">'
    r'|<meta property="og:[a-z_:]+" content="[^"]*">)\s*$')
HTML_TAG = '<html lang="tr">'


class RenderError(ValueError):
    pass


def esc(value):
    return html.escape(value, quote=True)


def clean_text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise RenderError(f"[SEO-DATA] {label}: boş ya da metin değil")
    if value != value.strip() or CONTROL.search(value) or len(value) > MAX_TEXT:
        raise RenderError(f"[SEO-DATA] {label}: baş/son boşluk, kontrol karakteri ya da {MAX_TEXT} karakteri aşıyor")
    return value


def profile_base(name):
    profile = PROFILES.get(name)
    if profile is None:
        raise RenderError(f"[SEO-PROFILE] tanımsız profil: {name!r}")
    origin, prefix = profile["origin"], profile["prefix"]
    if not ORIGIN.match(origin) or not PREFIX.match(prefix):
        raise RenderError(f"[SEO-PROFILE] geçersiz origin/önek: {origin!r} {prefix!r}")
    return origin + prefix


def absolute(base, path):
    """Profil köküne göre mutlak URL; sonuç https, aynı host, yol aşımı ve fragment yok."""
    url = base + path
    parts = urlsplit(url)
    root = urlsplit(base)
    if parts.scheme != "https" or parts.netloc != root.netloc or parts.fragment or parts.username \
            or not parts.path.startswith(root.path) or "/../" in parts.path or "/./" in parts.path \
            or "//" in parts.path or ":" in parts.path:
        raise RenderError(f"[SEO-URL] geçersiz mutlak URL: {url!r}")
    return url


def primary_recording(recordings):
    # work.js resolveWork() ile aynı kural: onaylı ilk kayıt başta, sonra kayıt kimliği.
    return sorted(recordings, key=lambda r: (r.get("isOriginal") is not True, r["id"]))[0]


def has_video(recording):
    videos = recording.get("videos") if isinstance(recording.get("videos"), list) else []
    return any(isinstance(v, dict) and v.get("provider") == "youtube" and isinstance(v.get("videoId"), str)
               and YOUTUBE_ID.match(v["videoId"]) and v.get("videoType") in VIDEO_TYPES for v in videos)


def published(work, key):
    asset = work.get(key)
    return isinstance(asset, dict) and asset.get("status") == "published"


def join_tr(items):
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " ve " + items[-1]


def describe(work, title, collections, recordings, video):
    parts = [f"{SITE_NAME}'un {LANGUAGE_NAMES[work['language']]} eseri “{title}”."]
    if collections:
        parts.append(", ".join(collections) + " koleksiyonunda.")
    if len(recordings) > 1:
        parts.append(f"{len(recordings)} kayıt versiyonu.")
    content = [name for name, present in (("şarkı sözleri", published(work, "lyrics")),
                                          ("hikâyesi", published(work, "story")),
                                          ("video klibi", video)) if present]
    if content:
        sentence = join_tr(content) + " bu sayfada."
        parts.append(sentence[0].upper() + sentence[1:])
    return " ".join(parts)


def work_metadata(catalog, profile="preview"):
    """Eser kimliği sırasıyla [(eser kimliği, metadata sözlüğü)]; hatalı ya da yinelenen veride RenderError."""
    base = profile_base(profile)
    works = catalog.get("works")
    recordings = catalog.get("recordings")
    covers = catalog.get("covers")
    collections = catalog.get("collections")
    if not all(isinstance(x, list) for x in (works, recordings, covers, collections)):
        raise RenderError("[SEO-DATA] katalogda works/recordings/covers/collections listesi yok")

    ids = [w.get("id") if isinstance(w, dict) else None for w in works]
    for work_id in ids:
        if not isinstance(work_id, str) or not WORK_ID.match(work_id):
            raise RenderError(f"[SEO-DATA] geçersiz eser kimliği: {work_id!r}")
    duplicates = sorted({i for i in ids if ids.count(i) > 1})
    if duplicates:
        raise RenderError(f"[SEO-DUP] yinelenen eser kimliği: {duplicates[:5]}")

    cover_by_id = {}
    for cover in covers:
        cover_id = cover.get("id") if isinstance(cover, dict) else None
        if not isinstance(cover_id, str) or not COVER_ID.match(cover_id) or cover_id in cover_by_id:
            raise RenderError(f"[SEO-DATA] geçersiz ya da yinelenen kapak kimliği: {cover_id!r}")
        cover_by_id[cover_id] = cover
    member_of = {}
    for collection in sorted(collections, key=lambda c: (c.get("order", 0), c.get("id", ""))):
        title = clean_text(collection.get("title"), f"koleksiyon {collection.get('id')} başlığı")
        for member in collection.get("members", []):
            member_of.setdefault(member.get("workId"), []).append(title)

    result = []
    for work in sorted(works, key=lambda w: w["id"]):
        work_id = work["id"]
        title = clean_text(work.get("title") or work.get("workingTitle"), f"{work_id} başlığı")
        if work.get("language") not in LANGUAGE_NAMES:
            raise RenderError(f"[SEO-DATA] {work_id}: bilinmeyen dil {work.get('language')!r}")
        own = [r for r in recordings if isinstance(r, dict) and r.get("workId") == work_id]
        if not own:
            raise RenderError(f"[SEO-DATA] {work_id}: kaydı yok")
        primary = primary_recording(own)
        cover = cover_by_id.get(primary.get("coverId"))
        if cover is None:
            raise RenderError(f"[SEO-DATA] {work_id}: kapak yok ({primary.get('coverId')!r})")
        images = [i for i in cover.get("webImages", []) if isinstance(i, dict)]
        if not images:
            raise RenderError(f"[SEO-DATA] {work_id}: kapağın web görseli yok")
        image = max(images, key=lambda i: i.get("width") or 0)  # work.js largestImage()
        path, digest = image.get("path"), image.get("sha256")
        width, height = image.get("width"), image.get("height")
        if not isinstance(path, str) or not IMAGE_PATH.match(path) or not isinstance(digest, str) \
                or not SHA256.match(digest) or not all(isinstance(v, int) and v > 0 for v in (width, height)) \
                or image.get("format") not in IMAGE_TYPES:
            raise RenderError(f"[SEO-DATA] {work_id}: geçersiz kapak görseli {path!r}")

        description = describe(work, title, member_of.get(work_id, []), own, has_video(primary))
        canonical = absolute(base, "music/work/" + work_id)
        meta = {
            "title": f"{title} | Müzik Dünyam | {SITE_NAME}",  # work.js applySeo() biçimi
            "description": description,
            "canonical": canonical,
            "ogTitle": f"{title} | {SITE_NAME}",
            "ogUrl": canonical,
            "ogImage": absolute(base, "music/" + path + "?v=" + digest[:12]),  # work.js imageUrl() kuralı
            "ogImageType": IMAGE_TYPES[image["format"]],
            "ogImageWidth": str(width),
            "ogImageHeight": str(height),
            "ogImageAlt": f"{title} kapak görseli",
            "twitterCard": "summary",  # kare kapak: geniş kart 2:1 kırpar
        }
        result.append((work_id, meta))

    for key in ("title", "description", "canonical", "ogImage"):
        values = [m[key] for _, m in result]
        repeated = sorted({v for v in values if values.count(v) > 1})
        if repeated:
            raise RenderError(f"[SEO-DUP] yinelenen {key}: {repeated[:3]}")
    return result


def template_region(text):
    """Şablondaki varsayılan metadata bölgesinin (başlangıç, bitiş) satır aralığı ve site adı/yerel ayarı."""
    lines = text.split("\n")
    titles = [i for i, line in enumerate(lines) if "<title>" in line]
    if len(titles) != 1 or text.count("<title") != 1 or not REGION_LINE.match(lines[titles[0]]) \
            or text.count(HTML_TAG) != 1 or 'rel="canonical"' in text or "twitter:" in text \
            or "data-work-id" in text:
        raise RenderError("[SEO-TEMPLATE] şablonda tek <title>, tek <html lang=\"tr\"> beklenir; canonical/twitter/data-work-id olmamalı")
    start = end = titles[0]
    while start > 0 and REGION_LINE.match(lines[start - 1]) and lines[start - 1].strip().startswith("<!--"):
        start -= 1
    while end + 1 < len(lines) and REGION_LINE.match(lines[end + 1]):
        end += 1
    region = "\n".join(lines[start:end + 1])
    outside = "\n".join(lines[:start] + lines[end + 1:])
    if any(token in outside for token in ('name="description"', 'property="og:', "<title>")):
        raise RenderError("[SEO-TEMPLATE] metadata etiketleri bölgenin dışında da var")
    found = dict(re.findall(r'<meta property="(og:site_name|og:locale)" content="([^"]*)">', region))
    if set(found) != {"og:site_name", "og:locale"} or region.count('name="description"') != 1:
        raise RenderError("[SEO-TEMPLATE] bölgede description, og:site_name ve og:locale bulunmalı")
    indent = re.match(r"^\s*", lines[titles[0]]).group(0)
    return lines, start, end, indent, html.unescape(found["og:site_name"]), html.unescape(found["og:locale"])


def head_block(work_id, meta, indent, site_name, locale):
    def tag(kind, key, value):
        return f'<meta {kind}="{key}" content="{esc(value)}">'
    rows = [
        f"<!-- render_pages.py tarafından {work_id} için üretildi: statik metadata; work.js bu etiketleri değiştirmez. -->",
        f"<title>{esc(meta['title'])}</title>",
        tag("name", "description", meta["description"]),
        f'<link rel="canonical" href="{esc(meta["canonical"])}">',
        tag("property", "og:type", "website"),
        tag("property", "og:site_name", site_name),
        tag("property", "og:locale", locale),
        tag("property", "og:title", meta["ogTitle"]),
        tag("property", "og:description", meta["description"]),
        tag("property", "og:url", meta["ogUrl"]),
        tag("property", "og:image", meta["ogImage"]),
        tag("property", "og:image:type", meta["ogImageType"]),
        tag("property", "og:image:width", meta["ogImageWidth"]),
        tag("property", "og:image:height", meta["ogImageHeight"]),
        tag("property", "og:image:alt", meta["ogImageAlt"]),
        tag("name", "twitter:card", meta["twitterCard"]),
        tag("name", "twitter:title", meta["ogTitle"]),
        tag("name", "twitter:description", meta["description"]),
        tag("name", "twitter:image", meta["ogImage"]),
        tag("name", "twitter:image:alt", meta["ogImageAlt"]),
    ]
    return [indent + row for row in rows]


def render_work_pages(catalog, template_bytes, profile="preview"):
    """{çıktı yolu: bayt}. Şablon UTF-8 olmalı; satır sonları şablondan korunur."""
    try:
        text = template_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise RenderError(f"[SEO-TEMPLATE] şablon UTF-8 değil: {exc}") from None
    newline = "\r\n" if "\r\n" in text else "\n"
    lines, start, end, indent, site_name, locale = template_region(text.replace("\r\n", "\n"))
    pages = {}
    for work_id, meta in work_metadata(catalog, profile):
        body = lines[:start] + head_block(work_id, meta, indent, site_name, locale) + lines[end + 1:]
        page = "\n".join(body).replace(HTML_TAG, f'<html lang="tr" data-work-id="{work_id}">', 1)
        pages[OUTPUT_DIR + work_id + ".html"] = page.replace("\n", newline).encode("utf-8")
    return pages
