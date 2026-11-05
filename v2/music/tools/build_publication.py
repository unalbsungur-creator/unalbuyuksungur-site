#!/usr/bin/env python3
"""V2 web yayın paketi oluşturucu (allowlist; Cloudflare Pages ve yerel önizleme için).

Görev 30–31: depo kökü olduğu gibi yayımlanmaz. Yalnızca sitenin çalışması için gereken V2 dosyaları,
v2/ öneki korunarak çıktı klasörüne bayt bayt kopyalanır. Allowlist sabit site dosyalarından ve
catalog.json'daki yollardan türetilir; WebP'ler catalog.json'daki, söz/hikâye dosyaları
verify_content_integrity.py'deki onaylı SHA-256 değeriyle doğrulanır; geliştirme araçları (tools/), data/README.md, emekli söz dosyaları,
Git yapılandırması ve V1 dosyaları pakete hiç girmez.

Görev 73: her eser için statik sayfa (v2/music/work/w-0001.html …) render_pages.py ile eser şablonundan
üretilir. Bu sayfalar kaynakta yoktur, yalnızca pakette bulunur; manifestte "pages" altında şablon SHA-256'sıyla
kaydedilir. Kopyalanan dosyalar (şablonun kendisi dahil) kaynakla bayt bayt aynı kalır.

Sıra: kaynak ve katalog denetimi -> geçici staging klasöründe kopyalama ve sayfa üretimi -> SHA-256 ve bağlantı denetimi ->
çıktı kümesinin allowlist'e tam eşitliği -> staging'in çıktı klasörüyle güvenli yer değiştirmesi. Herhangi
bir denetim başarısız olursa staging silinir, mevcut çıktı klasörüne dokunulmaz ve çıkış kodu 1 olur.
Kaynak dosyalar yalnızca okunur.

Görev 220: paket /v2/ öneki olmadan köke yazılır (v2/index.html -> index.html, v2/music/... -> music/...).
Kaynak v2/ altında kalır; bütün denetimler depo yollarıyla yapılır, yalnız yazma adımında önek düşer.
V1 görselleri (v2/legacy/v1-images/) aynı adlarla images/ altına, Perspective perspective/ altına yazılır.
İki profil vardır: preview (pages.dev, her yerde noindex) ve production (unalbuyuksungur.com; noindex yalnız
pages.dev adreslerinde). Profil; canonical/hreflang/OG kökünü, _headers, robots.txt ve sitemap.xml'i belirler.

Kullanım:
    python v2/music/tools/build_publication.py --out _site                       (varsayılan: preview)
    python v2/music/tools/build_publication.py --profile production --out _site
    python v2/music/tools/build_publication.py --out _site --expect-count 417

Cloudflare Pages (ayrı V2 projesi): build command
    python3 v2/music/tools/build_publication.py --out _site
    (canlı alan adı için: --profile production)
build output directory: _site

Çıkış kodu: paket üretildiyse 0, aksi hâlde 1.
"""

import argparse
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

sys.dont_write_bytecode = True  # v2/ altında __pycache__ oluşmasın (herkese açık klasör)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_catalog import RETIRED_CONTENT  # noqa: E402  (kurallar tek yerde)
from verify_content_integrity import CONTENT_SHA256  # noqa: E402  (onaylı söz/hikâye SHA-256 tablosu)
import render_pages  # noqa: E402  (statik eser sayfaları)
import render_site  # noqa: E402  (statik TR/EN/DE arayüz ve eser sayfaları)

DEFAULT_ROOT = Path(__file__).resolve().parents[3]

# Sabit site dosyaları (depo köküne göre). Başka HTML/CSS/JS/görsel eklenirse burası bilinçli güncellenmeli.
SITE_FILES = (
    "v2/index.html",
    "v2/external-links.js",
    # Görev 231: tüm header'lardaki "Müzik Stüdyosu" alt menüsünün ortak stili ve davranışı
    "v2/site-nav.css",
    "v2/site-nav.js",
    "v2/i18n/config.json",
    "v2/i18n/tr.json",
    "v2/i18n/en.json",
    "v2/i18n/de.json",
    "v2/i18n/runtime.js",
    "v2/i18n/selector.css",
    "v2/404.html",
    "v2/images/favicon.jpg.jpeg",
    "v2/images/unal-digital-world-hero.png",
    "v2/images/unal-digital-world-hero-800.webp",
    "v2/images/unal-digital-world-hero-1280.webp",
    "v2/images/unal-digital-world-hero-1672.webp",
    "v2/images/og/unal-digital-world-og-1200x630.jpg",
    "v2/images/projects/dilek-kutum-placeholder-1200.webp",
    "v2/images/projects/istec-placeholder-1200.webp",
    "v2/images/projects/mindot-homepage-1200.webp",
    "v2/images/projects/next-point-tr-homepage-1200.webp",
    "v2/images/projects/openfaos-placeholder-1200.webp",
    "v2/images/projects/tralvid-placeholder-1200.webp",
    "v2/music/index.html",
    "v2/music/catalog.css",
    "v2/music/catalog.js",
    "v2/music/work/index.html",
    "v2/music/work/work.css",
    "v2/music/work/work.js",
    "v2/studio/index.html",
    "v2/studio/studio.css",
    "v2/perspective/index.html",
    "v2/perspective/style.css",
    "v2/perspective/script.js",
    # Görev 221: yalnız Türkçe blog sayfaları (render_site.TR_PAGES) ve blog görselleri;
    # gizlilik sayfası Görev 231'den beri TR/EN/DE kabuk sayfasıdır (render_site.SHELL_ROUTES).
    "v2/blog/index.html",
    "v2/blog/blog.css",
    "v2/blog/yapay-zeka-ile-uretildi-diye-degersiz-mi/index.html",
    "v2/blog/2026-yazinda-turkiye-turizmi/index.html",
    "v2/blog/ne-yapayim/index.html",
    "v2/privacy/index.html",
    # Görev 226: taslak yasal metinler (yalnız TR, noindex; render_site.LEGAL_PAGES)
    "v2/yasal/on-bilgilendirme/index.html",
    "v2/yasal/mesafeli-satis/index.html",
    "v2/yasal/hizmet-kosullari/index.html",
    "v2/yasal/iade/index.html",
    "v2/yasal/kvkk/index.html",
    "v2/images/blog/yapay-zeka-ile-uretildi-diye-degersiz-mi-800.webp",
    "v2/images/blog/yapay-zeka-ile-uretildi-diye-degersiz-mi-1200.webp",
    "v2/images/blog/2026-yazinda-turkiye-turizmi-549.webp",
    "v2/images/blog/ne-yapayim-800.webp",
    "v2/images/blog/ne-yapayim-1200.webp",
)
# Görev 220: TR kabuk sayfaları kopyalanmaz, profile göre SEO etiketleriyle üretilir (render_site.SHELL_ROUTES).
RENDERED_SHELLS = ("v2/index.html", "v2/music/index.html", "v2/studio/index.html", "v2/privacy/index.html")
# Görev 221: yalnız Türkçe sayfalar da kopyalanmaz; canonical/OG etiketleriyle üretilir.
RENDERED_PAGES = RENDERED_SHELLS + tuple(render_site.TR_PAGES)
# 404 sayfası her adresten sunulur; kök-mutlak bağlantıya yalnız bu sayfada izin verilir.
NOT_FOUND = "v2/404.html"
# V1 görselleri: v2/legacy/v1-images/ altındaki kopyalar, pakette images/ altına aynı adlarla yazılır.
# Kök images/ klasörü ve main dalındaki V1 aynen kalır. SHA-256 değerleri sabittir.
LEGACY_IMAGES = "v2/legacy/v1-images/"
LEGACY_V1_IMAGES = {
    "benimle-yaslanacaktin.jpg": "0d3a934809db0f4d9f47ba593ac8617ec58a57e284ea3eaf57ca33b138a92162",
    "biliyorum.jpg": "f8347ecab951d613bfa068935344cfde0edab1e0eb905875e3d5777a650e2da4",
    "bir-kedim-var.jpg.jpg": "63fee54c7f324801b21688d8b86f11d9609ac8c3880825bb44df08188ef66097",
    "cat-cat-cat.jpg.jpg": "31a1e4cd58cb065307ddf631986869f8f240d7bb0735dc18eb1d034877ba4ece",
    "elimi-siktin.jpg": "a5831f18c552d9fe05fa94b72049f4f53435776abd5f87a664d2cf354ede78c6",
    "favicon.jpg.jpeg": "e4c5d514b1b6f40a3cc941f8da1a758269b5f3d0741d43846e93d3b8a0009f35",
    "haydi-dene.jpg.jpg": "03a1c28f888195a98f917327fde2560794b306238fccc27c19593fbf75b89f2e",
    "ne-yapayim.jpg": "11097f605e93ac09bf14f64489cee07e5fe01f8f3d578657fd2e62867e905a0c",
    "og-image.jpg.jpg.jpg": "e62aeadca54b1616713042d508ef18754fffba1daff3e810f15d6934ac44bf5b",
    "sebebi-sensin.jpg": "5305bf2be5b5006fb65c6332b9b313e1a5958a37fe5a2563e394021c7fa789a0",
    "seninle.jpg.jpg": "2a0abfa8ddcfcd627a1eed077d44787bf73fc8bfc8bf34613b11839cfc6f0ef7",
    "turkiye-turizmi.jpg": "c195a80e558ee84e888bcd4b01b89ee3b10c1e4952898a63dfd5fcf454de90d2",
    "yapay-zeka.jpg": "9c78a03fc2f005b020203834a91cb3250ec09fe724bddb997d0740102e1b0ff9",
}
MUSIC = "v2/music/"
CATALOG = MUSIC + "data/catalog.json"
CONTENT_PATH = re.compile(r"^content/(lyrics|stories)/[wr]-\d{4}\.txt$")  # work.js ile aynı kalıp
IMAGE_PATH = re.compile(r"^images/c-\d{4}-(400|800|1200)\.webp$")
SCHEMA_PATH = re.compile(r"^\./[a-z]+\.json$")
# JS içindeki yerel yol sabitleri: dosya -> {sabit: (beklenen değer, beklenen hedef dosya)}
JS_CONSTANTS = {
    MUSIC + "catalog.js": {"CATALOG_URL": ("data/catalog.json", CATALOG),
                           "DETAIL_URL": ("work/", MUSIC + "work/index.html")},
    MUSIC + "work/work.js": {"CATALOG_URL": ("../data/catalog.json", CATALOG),
                             "MUSIC_ROOT": ("../", MUSIC + "index.html")},
}

# Pages yapılandırma dosyaları: statik dosya olarak sunulmaz. İlk satır, bu aracın ürettiği bir çıktı
# klasörünü tanımak için işarettir (başka bir klasör asla silinmez).
MARKER = "# build_publication.py tarafından üretildi; elle düzenlemeyin."
PROFILES = tuple(render_pages.PROFILES)  # preview (varsayılan) | production
PREVIEW_HOST = "unalbuyuksungur-v2.pages.dev"
SECURITY_HEADERS = "  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n"
# Her iki profilde: eski /v2/ adresleri köke, V1'de og:image olarak paylaşılmış bozuk ad gerçek dosyaya.
REDIRECTS = (MARKER + "\n/v2    /        301\n/v2/   /        301\n/v2/*  /:splat  301\n"
             "/images/og-image.jpg.jpg  /images/og-image.jpg.jpg.jpg  301\n")


def generated(profile, pages):
    """Pages yapılandırması ve SEO dosyaları: {çıktı yolu: metin}. _headers'ın ilk satırı her zaman MARKER'dır."""
    if profile == "production":
        headers = (MARKER + f"\nhttps://{PREVIEW_HOST}/*\n  X-Robots-Tag: noindex\n"
                   f"https://:version.{PREVIEW_HOST}/*\n  X-Robots-Tag: noindex\n/*\n" + SECURITY_HEADERS)
        base = render_pages.profile_base(profile)
        files = {"_headers": headers, "_redirects": REDIRECTS,
                 "robots.txt": f"User-agent: *\nAllow: /\nSitemap: {base}sitemap.xml\n",
                 "sitemap.xml": sitemap(profile, pages)}
    else:
        files = {"_headers": MARKER + "\n/*\n  X-Robots-Tag: noindex\n" + SECURITY_HEADERS,
                 "_redirects": REDIRECTS, "robots.txt": "User-agent: *\nDisallow: /\n"}
    return files


def sitemap(profile, pages):
    """TR/EN/DE kabuk ve eser sayfaları; her biri hreflang alternatifleriyle (x-default = TR)."""
    routes = list(render_site.SHELL_ROUTES.values())
    routes += sorted("music/work/" + rel.rsplit("/", 1)[-1][:-5] for rel in pages
                     if re.fullmatch(r"v2/music/work/w-\d{4}\.html", rel))
    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">']
    for route in routes:
        alternates = [(locale, render_site.locale_url(locale, route, profile)) for locale in ("tr", "en", "de")]
        alternates.append(("x-default", render_site.locale_url("tr", route, profile)))
        for _locale, url in alternates[:3]:
            lines.append(f"  <url>\n    <loc>{html.escape(url)}</loc>")
            lines += [f'    <xhtml:link rel="alternate" hreflang="{code}" href="{html.escape(href, quote=True)}"/>'
                      for code, href in alternates]
            lines.append("  </url>")
    # Görev 222: /blog/ noindex olduğu, yazı sayfaları canonical'ı Blogspot'a verdiği için sitemap'e girmez.
    lines.append("</urlset>")
    return "\n".join(lines) + "\n"


def published_path(rel):
    """Depo yolunu paket yoluna çevirir: v2/ öneki düşer, V1 görselleri images/ altına yazılır."""
    if rel.startswith(LEGACY_IMAGES):
        return "images/" + rel[len(LEGACY_IMAGES):]
    if not rel.startswith("v2/"):
        raise BuildError(f"[OUT-PATH] v2/ dışında yayın yolu: {rel}")
    return rel[len("v2/"):]

# Görev 226: doldurulmamış köşeli parantezli yer tutucular ([AÇIK ADRES], [HUKUKÇU KONTROLÜ: …] gibi).
# Production profilinde uyarı verir (hata değil); sayfalar yine üretilir.
PLACEHOLDER = re.compile(r"\[[A-ZÇĞİÖŞÜ][A-ZÇĞİÖŞÜ ]{2,}(?::[^\]<\n]*)?\]")


def placeholders(pages):
    """{paket yolu: [yer tutucular]} — yalnız yer tutucu içeren üretilmiş sayfalar."""
    found = {}
    for rel, data in sorted(pages.items()):
        hits = list(dict.fromkeys(PLACEHOLDER.findall(data.decode("utf-8"))))
        if hits:
            found[published_path(rel)] = hits
    return found


# Son savunma: çıktıda bulunmaması gereken her şey (allowlist'e yanlışlıkla girse bile).
FORBIDDEN_OUTPUT = re.compile(
    r"(^|/)(\.[^/]*|tools|optimization-test|functions|__pycache__|node_modules)(/|$)"
    r"|\.(py|pyc|md|docx?|bak|tmp|log)$|(^|/)README|(^|/)r-\d{4}\.txt$|-eski\.|(^|/)_worker\.js$|_routes\.json$",
    re.IGNORECASE)


class BuildError(Exception):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def checked_source(root, rel):
    """Göreli yolu doğrular, depo içinde kalan gerçek bir dosyaya çözer; baytlarını döndürür."""
    if not rel or "\\" in rel or rel.startswith("/") or re.match(r"^[A-Za-z]:", rel):
        raise BuildError(f"[SRC-PATH] geçersiz yol: {rel!r}")
    parts = rel.split("/")  # ham bileşenler: PurePosixPath "//" ve "." bileşenlerini sessizce atar
    if any(p in ("", ".", "..") for p in parts) or parts[0] != "v2":
        raise BuildError(f"[SRC-PATH] v2/ dışına ya da üst klasöre çıkan yol: {rel!r}")
    current = root
    for part in parts:  # her bileşen: sembolik bağ ya da junction kabul edilmez
        current = current / part
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise BuildError(f"[SRC-LINK] sembolik bağ/junction: {rel}")
    try:
        resolved = current.resolve(strict=True)
    except FileNotFoundError:
        raise BuildError(f"[SRC-MISSING] kaynak dosya yok: {rel}") from None
    if not resolved.is_relative_to(root / "v2"):
        raise BuildError(f"[SRC-ESCAPE] depo dışına çözülüyor: {rel}")
    if not resolved.is_file():
        raise BuildError(f"[SRC-TYPE] normal dosya değil: {rel}")
    return resolved.read_bytes()


def load_catalog(root):
    try:
        return json.loads(checked_source(root, CATALOG).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BuildError(f"[CAT-JSON] catalog.json okunamadı: {exc}") from None


def plan(root, catalog):
    """Allowlist: {depo göreli yol: (beklenen SHA-256, bayt) ya da None}. Katalog yolları kalıplarla sınırlıdır."""
    files = {rel: None for rel in SITE_FILES if rel not in RENDERED_PAGES}
    files[CATALOG] = None
    legacy = root / LEGACY_IMAGES
    if not legacy.is_dir():
        raise BuildError(f"[SRC-MISSING] klasör yok: {LEGACY_IMAGES}")
    for entry in sorted(legacy.iterdir()):
        if entry.name not in LEGACY_V1_IMAGES:
            raise BuildError(f"[SRC-UNEXPECTED] onaylı V1 görsel listesinde olmayan dosya: {LEGACY_IMAGES}{entry.name}")
    for name, digest in LEGACY_V1_IMAGES.items():
        files[LEGACY_IMAGES + name] = (digest, None)
    schema = catalog.get("$schema")
    if not isinstance(schema, str) or not SCHEMA_PATH.match(schema):
        raise BuildError(f"[CAT-SCHEMA] beklenmeyen $schema: {schema!r}")
    files[MUSIC + "data/" + schema[2:]] = None
    for work in catalog.get("works", []):
        for key in ("lyrics", "story"):
            asset = work.get(key) or {}
            if asset.get("status") != "published":
                continue
            path = asset.get("file")
            if not isinstance(path, str) or not CONTENT_PATH.match(path):
                raise BuildError(f"[CAT-CONTENT] {work.get('id')} {key}: geçersiz yol {path!r}")
            if path not in CONTENT_SHA256:
                raise BuildError(f"[HASH-CONTENT] onaylı SHA-256 tablosunda yok: {path}")
            files[MUSIC + path] = (CONTENT_SHA256[path], None)
    for cover in catalog.get("covers", []):
        for image in cover.get("webImages", []):
            path = image.get("path")
            if not isinstance(path, str) or not IMAGE_PATH.match(path):
                raise BuildError(f"[CAT-IMAGE] {cover.get('id')}: geçersiz yol {path!r}")
            if MUSIC + path in files:
                raise BuildError(f"[CAT-IMAGE] aynı görsel iki kez: {path}")
            files[MUSIC + path] = (image.get("sha256"), image.get("bytes"))
    # Katalogda olmayan içerik/görsel dosyası: yalnızca onaylı emekli dosyalar (değişmemişse) atlanır.
    for folder, allowed in (("content/lyrics", RETIRED_CONTENT), ("content/stories", {}), ("images", {})):
        directory = root / MUSIC / folder
        if not directory.is_dir():
            raise BuildError(f"[SRC-MISSING] klasör yok: {MUSIC}{folder}")
        for entry in sorted(directory.iterdir()):
            rel = f"{folder}/{entry.name}"
            if MUSIC + rel in files:
                continue
            if rel in allowed and sha256(checked_source(root, MUSIC + rel)) == allowed[rel]:
                continue
            raise BuildError(f"[SRC-UNEXPECTED] katalogda olmayan dosya: {MUSIC}{rel}")
    return files


def render(root, catalog, files, profile):
    """Statik TR/EN/DE arayüz ve eser sayfaları; iki kez üretilip karşılaştırılır."""
    template = checked_source(root, render_pages.TEMPLATE)
    sources = {rel: checked_source(root, rel) for rel in SITE_FILES
               if rel.endswith((".html", ".json"))}
    try:
        pages = render_site.render(catalog, sources, profile)
        again = render_site.render(catalog, sources, profile)
    except (render_pages.RenderError, render_site.LocaleError, ValueError) as exc:
        raise BuildError(str(exc)) from None
    if pages != again:
        raise BuildError("[SEO-DETERMINISM] aynı girdiyle iki üretim farklı")
    for rel in pages:
        if rel in files or FORBIDDEN_OUTPUT.search(rel):
            raise BuildError(f"[SEO-PATH] üretilen sayfa mevcut ya da yasak bir yolla çakışıyor: {rel}")
    return pages, sha256(template)


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name in ("href", "src") and value is not None:
                self.refs.append(value)
            elif name in ("srcset", "imagesrcset") and value is not None:
                # Görev 220: duyarlı görsel adayları ("yol 800w, yol 1280w") da denetlenir.
                self.refs += [c.strip().split()[0] for c in value.split(",") if c.strip()]


def resolve_ref(base, ref):
    """Göreli bağlantıyı depo göreli dosya yoluna çevirir; dış/sayfa içi bağlantılar için None."""
    parts = urlsplit(ref)
    if parts.scheme or parts.netloc or not parts.path:
        return None
    if parts.path.startswith("/"):
        if base != NOT_FOUND:
            raise BuildError(f"[REF-ABSOLUTE] kök göreli bağlantı desteklenmiyor: {ref}")
        # 404.html her adresten sunulur: kök-mutlak yol paket kökünden, yani depoda v2/ altından çözülür.
        target = os.path.normpath("v2" + parts.path).replace("\\", "/")
        return target.rstrip("/") + "/index.html" if parts.path.endswith("/") else target
    target = os.path.normpath(os.path.join(os.path.dirname(base), parts.path)).replace("\\", "/")
    if parts.path.endswith("/") or parts.path in (".", ".."):
        target = target.rstrip("/") + "/index.html"
    return target


def check_references(files, read):
    """HTML src/href, CSS url(), JS yol sabitleri ve katalog yolları allowlist'teki dosyalara çözülmeli."""
    count = 0
    for rel in sorted(files):
        if rel.endswith(".html"):
            parser = Links()
            parser.feed(read(rel).decode("utf-8"))
            refs = parser.refs
        elif rel.endswith(".css"):
            refs = [m.strip("'\"") for m in re.findall(r"url\(\s*([^)]+?)\s*\)", read(rel).decode("utf-8"))]
            refs = [r for r in refs if not r.startswith("data:")]
        else:
            refs = []
        for ref in refs:
            target = resolve_ref(rel, ref)
            if target is not None:
                count += 1
                if target not in files:
                    raise BuildError(f"[REF-MISSING] {rel}: {ref} -> {target} pakette yok")
    for rel, constants in JS_CONSTANTS.items():
        source = read(rel).decode("utf-8")
        for name, (value, target) in constants.items():
            match = re.search(r"var " + name + r' = "([^"]*)";', source)
            if not match or match.group(1) != value or resolve_ref(rel, value) != target or target not in files:
                raise BuildError(f"[REF-JS] {rel}: {name} beklenen {value!r} -> {target} değil")
            count += 1
    return count


def safe_out(root, out):
    if out.is_absolute() or ".." in out.parts or not out.parts:
        raise BuildError(f"[OUT-PATH] --out depo kökü altında göreli bir klasör olmalı: {out}")
    target = root / out
    for parent in [target, *target.parents]:
        if parent == root:
            break
        if parent.is_symlink() or (hasattr(parent, "is_junction") and parent.is_junction()):
            raise BuildError(f"[OUT-PATH] sembolik bağ/junction içeren çıktı yolu: {out}")
    if out.parts[0] in ("v2", ".git", "images", "perspective") or out.parts[0].startswith("."):
        raise BuildError(f"[OUT-PATH] kaynak klasörü çıktı olarak kullanılamaz: {out}")
    if target.exists():
        marker = target / "_headers"
        if not target.is_dir() or not marker.is_file() or \
                marker.read_text(encoding="utf-8").splitlines()[:1] != [MARKER]:
            raise BuildError(f"[OUT-FOREIGN] {out} bu aracın ürettiği bir çıktı değil; silinmedi")
    return target


def git_commit(root):
    if os.environ.get("CF_PAGES_COMMIT_SHA"):
        return os.environ["CF_PAGES_COMMIT_SHA"]
    try:
        return subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"], capture_output=True,
                              text=True, check=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None


def build(root, out, expect_count=None, manifest_path=None, log=print, profile="preview"):
    if profile not in PROFILES:
        raise BuildError(f"[PROFILE] tanımsız profil: {profile!r}; geçerli: {', '.join(PROFILES)}")
    root = root.resolve()
    target = safe_out(root, out)
    catalog = load_catalog(root)
    files = plan(root, catalog)
    pages, template_digest = render(root, catalog, files, profile)
    extra_files = generated(profile, pages)
    if profile == "production":
        for path, hits in placeholders(pages).items():
            log(f"UYARI [PLACEHOLDER] {path}: {', '.join(hits)}")

    staging = target.with_name(f"{target.name}.staging-{os.getpid()}")
    if staging.exists():
        shutil.rmtree(staging)
    staging.mkdir(parents=True)
    try:
        # Görev 220: denetimler depo yollarıyla yapılır; yalnız yazarken v2/ öneki düşer (published_path).
        written = {}  # paket yolu -> (depo yolu, SHA-256)
        aliases = []
        entries = []
        for rel in sorted(files):
            data = checked_source(root, rel)
            digest = sha256(data)
            expected = files[rel]
            if expected and (expected[0] != digest or expected[1] not in (None, len(data))):
                raise BuildError(f"[HASH-EXPECTED] {rel}: onaylı SHA-256/bayt değeriyle uyuşmuyor")
            if FORBIDDEN_OUTPUT.search(rel):
                raise BuildError(f"[OUT-FORBIDDEN] yasak dosya allowlist'te: {rel}")
            path = published_path(rel)
            if path in written:
                # Aynı paket yoluna iki kaynak: yalnız baytları birebir aynıysa kabul edilir (ör. favicon).
                if written[path][1] != digest:
                    raise BuildError(f"[OUT-COLLISION] {path}: {written[path][0]} ve {rel} farklı içerikte")
                aliases.append({"path": path, "source": rel, "sameAs": written[path][0], "sha256": digest})
                continue
            written[path] = (rel, digest)
            dest = staging / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            if sha256(dest.read_bytes()) != digest:
                raise BuildError(f"[HASH-COPY] kopya kaynakla aynı değil: {rel}")
            entries.append({"path": path, "source": rel, "bytes": len(data), "sha256": digest})
        page_entries = []
        for rel in sorted(pages):
            path = published_path(rel)
            if path in written or path in extra_files:
                raise BuildError(f"[OUT-COLLISION] üretilen sayfa başka bir dosyayla çakışıyor: {path}")
            written[path] = (rel, sha256(pages[rel]))
            dest = staging / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(pages[rel])
            if dest.read_bytes() != pages[rel]:
                raise BuildError(f"[HASH-COPY] üretilen sayfa yazılamadı: {rel}")
            source = (rel if rel in render_site.TR_PAGES
                      else "v2/index.html" if re.fullmatch(r"v2/((en|de)/)?index\.html", rel)
                      else "v2/music/index.html" if re.fullmatch(r"v2/((en|de)/)?music/index\.html", rel)
                      else "v2/studio/index.html" if re.fullmatch(r"v2/((en|de)/)?studio/index\.html", rel)
                      else "v2/privacy/index.html" if re.fullmatch(r"v2/((en|de)/)?privacy/index\.html", rel)
                      else render_pages.TEMPLATE)
            page_entries.append({"path": path, "source": rel, "bytes": len(pages[rel]),
                                 "sha256": sha256(pages[rel]), "template": source,
                                 "templateSha256": sha256(checked_source(root, source))})
        for name, text in extra_files.items():
            if name in written:
                raise BuildError(f"[OUT-COLLISION] üretilen yapılandırma bir site dosyasıyla çakışıyor: {name}")
            (staging / name).write_bytes(text.encode("utf-8"))

        def read_staged(rel):
            return (staging / published_path(rel)).read_bytes()
        references = check_references(set(files) | set(pages), read_staged)

        produced = sorted(p.relative_to(staging).as_posix() for p in staging.rglob("*") if not p.is_dir())
        expected_set = sorted({*written, *extra_files})
        if produced != expected_set:
            extra = sorted(set(produced) - set(expected_set))
            missing = sorted(set(expected_set) - set(produced))
            raise BuildError(f"[OUT-SET] çıktı allowlist'e eşit değil; fazla {extra[:5]}, eksik {missing[:5]}")
        bad = [p for p in produced if p not in extra_files and FORBIDDEN_OUTPUT.search(p)]
        if bad or any(p.is_symlink() for p in staging.rglob("*")):
            raise BuildError(f"[OUT-FORBIDDEN] çıktıda yasak dosya ya da bağ: {bad[:5]}")
        web = sorted(entries + page_entries, key=lambda e: e["path"])
        if expect_count is not None and len(web) != expect_count:
            raise BuildError(f"[OUT-COUNT] {len(web)} web dosyası; beklenen {expect_count}")

        digest = sha256("".join(f"{e['path']}  {e['sha256']}\n" for e in web).encode("utf-8"))
        copied = {e["source"] for e in entries}
        groups = {
            "site": sum(rel in SITE_FILES for rel in copied),
            "data": sum(rel.startswith(MUSIC + "data/") for rel in copied),
            "lyrics": sum(rel.startswith(MUSIC + "content/lyrics/") for rel in copied),
            "stories": sum(rel.startswith(MUSIC + "content/stories/") for rel in copied),
            "webp": sum(rel.startswith(MUSIC + "images/") for rel in copied),
            "legacyImages": sum(rel.startswith(LEGACY_IMAGES) for rel in copied),
            "pages": len(pages),
        }
        manifest = {
            "tool": "v2/music/tools/build_publication.py",
            "commit": git_commit(root),
            "output": out.as_posix(),
            "profile": profile,
            "webFiles": len(web),
            "copiedFiles": len(entries),
            "renderedPages": len(page_entries),
            "generatedFiles": sorted(extra_files),
            "totalOutputFiles": len(produced),
            "webBytes": sum(e["bytes"] for e in web),
            "groups": groups,
            "checkedReferences": references,
            "packageDigest": digest,
            "files": entries,
            "aliases": aliases,
            "pages": page_entries,
        }

        # Güvenli yer değiştirme: eski çıktı önce kenara alınır, yeni paket yerine taşınır, sonra eski silinir.
        previous = target.with_name(f"{target.name}.previous-{os.getpid()}")
        if target.exists():
            target.rename(previous)
        try:
            staging.rename(target)
        except OSError:
            if previous.exists():
                previous.rename(target)
            raise
        if previous.exists():
            shutil.rmtree(previous)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)

    if manifest_path is not None:
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"V2 yayın paketi: {out.as_posix()}/ (profil: {profile})")
    log(f"  web dosyası {len(web)}: kopyalanan {len(entries)} (site {groups['site']}, veri {groups['data']}, "
        f"söz {groups['lyrics']}, hikâye {groups['stories']}, WebP {groups['webp']}, V1 görsel "
        f"{groups['legacyImages']}) + üretilen sayfa "
        f"{len(page_entries)} ({profile}) + yapılandırma/SEO {len(extra_files)} = {len(produced)} dosya, "
        f"{manifest['webBytes']} bayt")
    log(f"  denetlenen bağlantı {references}; kaynak-çıktı SHA-256 eşleşmesi {len(entries)}/{len(entries)}")
    log(f"  commit {manifest['commit']}")
    log(f"  paket özeti (SHA-256) {digest}")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out", type=Path, required=True, help="depo köküne göre çıktı klasörü (ör. _site)")
    parser.add_argument("--profile", choices=PROFILES, default="preview",
                        help="preview (pages.dev, noindex; varsayılan) ya da production (unalbuyuksungur.com)")
    parser.add_argument("--expect-count", type=int, help="beklenen web dosyası sayısı (farklıysa build durur)")
    parser.add_argument("--manifest", type=Path, help="manifest JSON yolu (varsayılan: depo kökünde <out>-manifest.json)")
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help=argparse.SUPPRESS)  # testler için
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    root = args.root.resolve()
    manifest = args.manifest or root / f"{args.out.name}-manifest.json"
    try:
        build(root, args.out, args.expect_count, manifest, profile=args.profile)
    except (BuildError, OSError) as exc:
        print(f"BUILD FAILED: {exc}", file=sys.stderr)
        print("Yayın paketi üretilmedi; mevcut çıktı klasörü değiştirilmedi.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
