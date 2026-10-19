# Müzik Kataloğu — Veri Temeli

Ünal Büyüksungur'un müzik çalışmalarının statik site için katalog verisi.
Framework veya derleme adımı gerektirmez; `catalog.json` doğrudan `fetch()` ile okunabilir.

| Dosya | Görev |
|---|---|
| `catalog.json` | Tek veri kaynağı |
| `schema.json` | Veri yapısı (JSON Schema 2020-12) |
| `../tools/validate_catalog.py` | Salt okunur doğrulayıcı (standart kütüphane; WebP çözümleme kontrolleri için Pillow) |
| `../images/` | Kapakların web görselleri: `c-0001-400.webp`, `c-0001-800.webp`, `c-0001-1200.webp` … |

## Varlıklar

- **Work (eser)** — `w-0001` … Bestenin kendisi: başlık, slug, dil, söz/hikâye durumu, yayın durumu.
- **Recording (kayıt/versiyon)** — `r-0001` … Bir eserin belirli bir kaydı: versiyon etiketi, tür, ilk/orijinal bilgisi, kapak, yayın tarihi, platform bağlantıları.
- **CoverAsset (kapak)** — `c-0001` … Arşivdeki kaynak kapak: orijinal dosya adı (birebir), gerçek format, çözünürlük, boyut, SHA-256. `webImages` üç web görselini listeler (aşağıya bakın).
- **Collection (koleksiyon)** — `col-0001` … Başlık, slug, açıklama, sıra ve üyeler. `members` dizisinin sırası koleksiyon içi sıradır. Burç üyelerinde tarih aralığı `dateRange` alanında tutulur, başlığa eklenmez.
- **RelatedWork (ilişki)** — `rel-0001` … Eserler arası ilişki. `adaptation` yönsüzdür: `source`/`target` sırası anlam taşımaz.
- **openIssues** — `oi-0001` … Karar bekleyen konular. Bu konulardaki alanlar bilinçli olarak `null`, boş veya `unknown` bırakılmıştır.

ID'ler kalıcıdır ve başlıktan bağımsızdır; başlık veya slug değişse de ID değişmez. Yeni kayıtlara sıradaki boş numara verilir, silinen ID tekrar kullanılmaz.

## Tek kaynak ilkesi

İlişkiler tek yerde tutulur, ters yönler türetilir:

```js
const recordingsOf = (workId) => catalog.recordings.filter(r => r.workId === workId);
const collectionsOf = (workId) => catalog.collections.filter(c => c.members.some(m => m.workId === workId));
const adaptationsOf = (workId) => catalog.relations
  .filter(r => r.type === "adaptation" && (r.source === workId || r.target === workId))
  .map(r => (r.source === workId ? r.target : r.source));
```

## Web görselleri

Her CoverAsset için 400, 800 ve 1200 px kare WebP üretilmiştir. Dosya adı CoverAsset ID'sine bağlıdır;
kaynak dosya adındaki Türkçe karakterlerden ve başlık değişikliklerinden etkilenmez.

```json
{ "path": "images/c-0001-400.webp", "format": "webp", "width": 400, "height": 400, "bytes": 26510, "sha256": "5e3951c4…" }
```

- `path`, `v2/music/` klasörüne göredir (ör. `/v2/music/images/c-0001-400.webp`).
- Üretim ayarı: Pillow, kaynak RGB'ye çevrilir, Lanczos ile küçültülür, WebP kayıplı `quality=80`, `method=6`.
  Kırpma, renk düzeltme veya keskinleştirme yapılmaz; aynı kaynak ve ayar bayt bayt aynı çıktıyı verir.
- Kullanım önerisi: katalog kartı 400 (retina için `srcset` ile 800), detay sayfası 800/1200.

```js
const cover = catalog.covers.find(c => c.id === recording.coverId);
const srcset = cover.webImages.map(i => `${i.path} ${i.width}w`).join(", ");
```

## İçerik yayını: şarkı sözleri, hikâyeler, dinleme bağlantıları

Sitede yalnızca doğrulanmış ve yayımlanmış içerik görünür. Hiçbir söz, hikâye veya bağlantı tahminle eklenmez.

### Sahiplik

| İçerik | Nerede tutulur | Neden |
|---|---|---|
| Şarkı sözleri | `work.lyrics` | Sözler bestenindir; Pop ve Rock Ballad gibi versiyonlar aynı sözü paylaşır, metin tekrarlanmaz. |
| Kayda özel söz (istisna) | `recording.lyrics` (isteğe bağlı) | Yalnızca bir kaydın sözleri eserinkinden **gerçekten** farklıysa eklenir. Alan yoksa eserin sözleri kullanılır. Detay sayfası, seçili versiyonun yayımlanmış istisnası varsa onu gösterir. |
| Notaların Ardındaki Hikâye | `work.story` | Eserin yazılış hikâyesi besteye aittir. |
| Dinleme bağlantıları | `recording.links` | Her versiyonun ayrı Spotify / YouTube adresi olur. Bir adres yalnızca bir kayda bağlanır. |

Kayda özel bir *üretim* hikâyesi (ör. Rock Ballad düzenlemesinin nasıl kaydedildiği) bugün şemada yoktur. Gerekirse
`recording.story` adıyla, `textAsset` yapısında ve `content/stories/r-XXXX.txt` yoluyla ayrı bir içerik olarak eklenmeli;
eserin hikâyesinin yerine geçmemeli, detay sayfasında ayrı başlıkla gösterilmelidir. Bu yapılmadan önce şema,
doğrulayıcı ve `work/work.js` birlikte güncellenir.

### Durumlar (`textAsset.status`)

| Durum | Anlamı | `file` | Ziyaretçi ne görür |
|---|---|---|---|
| `missing` | İçerik yok. | `null` | Boş durum metni |
| `draft` | İçerik hazırlanıyor, herkese açık değil. | `null` | Boş durum metni |
| `published` | İçerik doğrulandı, yayımlanabilir. | `content/...txt` | Dosyadaki metin |

`published` içerik dosyası yüklenemezse, boşsa, geçerli UTF-8 değilse veya yolu kurala uymuyorsa sayfa
"… şu anda yüklenemedi" mesajını gösterir; içerik uydurulmaz, ham hata gösterilmez.

Dinleme bağlantılarının ayrı bir durum alanı yoktur: değer `null` ise bağlantı yoktur, doluysa doğrulanmış
ve yayımlanmış kabul edilir. Doğrulanmamış bir adres kataloğa hiç yazılmaz.

### Taslak güvenliği

`v2/music/` altındaki her dosya sitede herkese açık bir adresle yayımlanır; arayüzde gizlenen bir dosya da
doğrudan URL ile okunabilir. Bu yüzden:

- Taslak metinler **repoda tutulmaz**. Çalışma alanı kaynak arşivdir (`UNAL_MUSIC_ARCHIVE/lyrics`, `UNAL_MUSIC_ARCHIVE/stories`).
- `draft` içerik bir dosyaya bağlanmaz (`file: null`).
- `content/` klasöründe yalnızca `published` bir içeriğin işaret ettiği dosyalar bulunur; başka her dosya doğrulayıcıda FAIL olur (33).
  Tek istisna, Görev 25'te kayda bağlantısı kaldırılan ama kullanıcı kararıyla silinmeyen eski versiyon sözleridir
  (`r-0058.txt`, `r-0065.txt`); doğrulayıcıda SHA-256 ile sabitlenmiştir (`RETIRED_CONTENT`).

### Dosya standardı

- Yol `v2/music/` köküne göredir ve tam olarak şu biçimdedir:
  - Eser sözleri: `content/lyrics/w-0014.txt`
  - Kayda özel sözler: `content/lyrics/r-0014.txt`
  - Eser hikâyesi: `content/stories/w-0014.txt`
- Dosya adı yalnızca kalıcı kimlikten oluşur; başlık veya slug kullanılmaz (başlık değişse de yol değişmez).
- Paylaşılan içerik: Görev 25'te birleşik eserlerden ayrılan dört eser, kaynak eserin dosyalarına bağlıdır; metin
  çoğaltılmaz (w-0065 → w-0014, w-0066 → w-0020, w-0067 → w-0056, w-0068 → w-0061). Başka bir kimliğin dosyasına
  bağlanmaya yalnızca doğrulayıcıdaki `SHARED_CONTENT` listesindeki eserler için izin verilir (30).
- Mutlak yol, `http(s)://` adresi, `..` veya ters bölü kabul edilmez. Şema kalıbı ve doğrulayıcı (30) yolu
  kimlikle birebir karşılaştırır; tarayıcı da aynı kalıba uymayan yolu yüklemez.
- Biçim: **UTF-8, BOM'suz düz metin**. HTML veya Markdown yorumlanmaz; `<b>` gibi işaretler aynen metin olarak görünür.
- Satır sonları korunur. Boş satır yeni kıta/paragraf başlatır. Sekme ve satır sonu dışında kontrol karakteri olamaz.

### Dinleme bağlantıları

- Yalnızca `https://` adresleri; kullanıcı adı/şifre içeren veya boşluklu adresler kabul edilmez.
- Platform alanı adresin alan adıyla eşleşir: `spotify` → `spotify.com` / `spotify.link`, `youtube` → `youtube.com` / `youtu.be`,
  `youtubeMusic` → `music.youtube.com`, `appleMusic` → `music.apple.com`. Diğer platformlar `other` listesine
  `{ "platform": "Ad", "url": "https://…" }` biçiminde girer.
- Aynı adres iki kayda bağlanamaz; Pop ve Rock Ballad versiyonları kendi adreslerini taşır.

### Yeni içerik ekleme adımları

1. Eserin kimliğini katalogdan bulun (ör. Biliyorum = `w-0014`; Pop kaydı `r-0015`, Rock Ballad kaydı `r-0014`).
2. Metni repoda değil, arşivde hazırlayın ve sahibi tarafından onaylatın. Bu sürede durum `missing` ya da `draft` kalır, `file: null`.
3. Onaylı metni `v2/music/content/lyrics/w-0014.txt` (veya `stories/`) olarak BOM'suz UTF-8 kaydedin.
4. Katalogda ilgili alanı güncelleyin: `"lyrics": { "status": "published", "file": "content/lyrics/w-0014.txt" }`.
5. Bağlantı için ilgili **kaydın** `links` alanına doğrulanmış adresi yazın.
6. `python v2/music/tools/validate_catalog.py` çalıştırın; tüm kontroller PASS olmadan yayımlamayın.
7. Yerel sunucuda `v2/music/work/?id=w-0014` sayfasını açıp metni, satır sonlarını ve versiyon seçimini kontrol edin.

Yayından kaldırmak için durumu `missing` (veya `draft`) yapıp `file: null` verin ve dosyayı `content/` klasöründen silin.

### Word formlarından içe aktarım denetimi (dry-run)

`MÜZİK ESERİ BİLGİ FORMU` (.docx) ile gelen sözler, hikâyeler ve bağlantılar önce salt okunur araçla denetlenir:

```
python v2/music/tools/import_content_forms.py --input "Formlar/Eser_Formu.docx" --dry-run
```

- Araç yalnızca okur ve raporlar; `catalog.json`, `schema.json` ve `content/` değişmez (çalışma öncesi/sonrası SHA-256 ile doğrulanır).
- Doldurulmuş formları **repoda tutmayın**; özellikle `v2/` altındaki her dosya herkese açık yayımlanır.
- Bir belgede birden fazla form olabilir; her `A — ESER / WORK` başlığı yeni bir form başlatır, her `D — KAYIT` tablosu bir versiyondur.
- Eşleştirme sırası: doğrulanmış Work ID → tam başlık → kontrollü normalizasyon (büyük/küçük harf, tırnak, boşluk,
  sondaki nokta) → manuel inceleme. Benzer başlıklar ve tam eşleşmeyen versiyon adları otomatik bağlanmaz.
- Durumlar: `READY_FOR_REVIEW` (eşleşme kesin, eksik/hata yok), `INCOMPLETE` (zorunlu alan, onay eksik veya hatalı
  bağlantı/dönüşüm kaybı), `AMBIGUOUS` (eşleşme veya yayımlanmış içerikle çakışma manuel karar istiyor), `NOT_FOUND`.
- Rapor ve inceleme metinleri repo dışındaki geçici klasöre yazılır (`--report-dir` ile değiştirilebilir; repo içi reddedilir).
  Sözler/hikâyeler terminale basılmaz; "Yalnızca özel notlar" alanının metni hiçbir dosyaya yazılmaz.
- `READY_FOR_REVIEW` yayın anlamına gelmez: içerik yukarıdaki "Yeni içerik ekleme adımları" ile ve sahibinin onayıyla ayrıca eklenir.
- Testler (sentetik belgeler, gerçek katalog yalnızca okunur): `python v2/music/tools/test_import_content_forms.py`

### Şarkı arşivi belgesinden içe aktarım denetimi (dry-run)

Toplu şarkı arşivi Word belgesi bilgi formundan farklı yapıdadır ve ayrı araçla denetlenir:

```
python v2/music/tools/import_song_archive.py --source ../UNAL_MUSIC_ARCHIVE/incoming/<kaynak>.docx --dry-run --expect-sections 68 --report-dir ../rapor
```

- Eser sınırı Word'ün otomatik numaralı başlıklarıdır; sayfa sonları sınır sayılmaz. Hikâye, bölümde paragraf başındaki
  `Hikayesi:` / `Hikayesi :` / `Hikayesi 2026/` işaretiyle başlar (işaret satırı boşsa sonraki paragraf); sözdeki sıradan
  "hikâye" kelimesi işaret sayılmaz. Tek dönüşüm işaret önekinin ve bölüm kenarındaki boş paragrafların ayrılmasıdır.
- Her paragraf tek bir role atanır (başlık, söz, hikâye işareti, hikâye, kenar boşluğu); toplam tutmazsa veya iki okuma
  yöntemi farklı metin verirse yapısal hata olur. Word emojileri (`mc:AlternateContent`) yedek metinle okunur.
- Kullanıcı kararları araçta sabittir: onaylı başlık eşleşmeleri, 12 burcun ortak hikâyesi (kapsam `burc-serisi`
  koleksiyonundan) ve iki versiyonlu eserlerin ortak hikâyesi (w-0014, w-0020, w-0056, w-0061). Gizlilik taraması genel
  kalıplarla yapılır; eser bazında inceleme kararları kaynak kodda tutulmaz, gerekirse repo dışındaki bir JSON dosyasıyla
  `--privacy-review` parametresiyle verilir (repo içindeki dosya reddedilir).
- Söz kapsamı: eserin tüm bölümlerindeki söz birebir aynıysa `work.lyrics`, değilse her versiyon için `recording.lyrics`.
  Hikâye her zaman eser düzeyindedir; kaynak hikâyeler ve uygulanacak hikâye manifestte ayrı tutulur.
- Belirsiz eşleşme, farklı kaynak hikâyeler, işaretsiz hikâye adayı, yayımlanmış içerikle çakışma ve gizlilik incelemesi
  `PENDING_APPROVAL` olarak raporlanır; araç hiçbirini kendiliğinden çözmez ve dosya yazmaz.
- Rapor (`manifest.json`, `report.md`) repo dışına yazılır ve söz/hikâye metni içermez (başlık, kimlik, durum, sayım, hash).
- Testler: `python v2/music/tools/test_import_song_archive.py`

### Kalıcı kimlikler

Görev 05'te verilen 64 Work (`w-0001` … `w-0064`) ve 68 Recording kimliği ile kayıt → eser ve kayıt → kapak eşlemeleri
doğrulayıcıda sabitlenmiştir (36). Görev 25'te kullanıcı kararıyla dört birleşik eser ayrıldı: dört kayıt yeni eserlere
taşındı (r-0014 → w-0065, r-0021 → w-0066, r-0058 → w-0067, r-0065 → w-0068); toplam 68 Work. Eski birleşik eser
adresleri (`work/?id=w-0020&kayit=r-0021` gibi) eser sayfasında kaydın yeni eserine yönlendirilir. Yeni eser ve kayıt sıradaki numarayla eklenebilir; mevcut bir kimlik silinemez,
yeniden numaralandırılamaz ve başka bir esere taşınamaz. İçerik dosyaları, sayfa adresleri (`work/?id=w-0014`) ve
paylaşılan bağlantılar bu kimliklere dayanır.

## Kurallar

- Bilinmeyen bilgi uydurulmaz: `releaseDate: null`, platform bağlantıları `null`, `lyrics`/`story` için `status: "missing"`.
- `isOriginal`: `true` = onaylı ilk/orijinal kayıt, `false` = onaylı alternatif kayıt, `null` = bilinmiyor.
- `genres` yalnızca doğrulanmış türleri içerir; doğrulanmamışsa boş liste.
- Başlığı kesinleşmemiş eserde `title` ve `slug` `null`, `titleStatus: "unconfirmed"`, geçici ad `workingTitle` alanındadır.
- Başlıklar her kelimenin ilk harfi büyük olacak şekilde Türkçe kurallarla yazılır; Almanca başlıklar Almanca yazımı korur.
- Slug: Türkçe küçük harf (İ→i, I→ı), sonra ç→c, ğ→g, ı→i, ö→o, ş→s, ü→u, â/î/û→a/i/u. Almanca eserlerde ä→ae, ö→oe, ü→ue, ß→ss. Kesme işareti silinir, diğer işaretler tireye dönüşür.
- Kaynak arşiv (`UNAL_MUSIC_ARCHIVE`) salt okunurdur; dosya adları değiştirilmez.

## Doğrulama

Repo kökünden:

```
python v2/music/tools/validate_catalog.py
```

Arşiv farklı bir konumdaysa `--archive <yol>` verilir. Araç hiçbir dosya yazmaz; tüm kontroller geçerse çıkış kodu 0'dır.
Pillow kurulu değilse WebP'lerin tam çözümlenmesi (23) ve doğru kapağa ait olması (26) kontrolleri SKIP olur ve çıkış kodu 1 döner.
Kullanıcının onayladığı katalog kararları (burç üyeleri, versiyon grupları, uyarlama ilişkileri) araç içinde kaynak dosya adlarıyla sabitlenmiştir; bu kararlar değişirse araç da güncellenmelidir.

Kontroller 27–36 içerik yayınını denetler; her sorun bir hata koduyla raporlanır:

| Kontrol | Kod | Denetlenen |
|---|---|---|
| 27 | `CNT-STATUS` | Durum `missing` / `draft` / `published` dışında değil |
| 28 | `CNT-NOFILE` | `published` içeriğin dosya yolu var |
| 29 | `CNT-MISSING` | Yayımlanmış dosya diskte mevcut |
| 30 | `CNT-PATH` | Yol `content/{lyrics,stories}/<kimlik>.txt`; klasör dışına çıkmıyor |
| 31 | `CNT-UTF8` | BOM'suz geçerli UTF-8, kontrol karakteri yok |
| 32 | `CNT-EMPTY` | Yayımlanmış metin boş değil |
| 33 | `CNT-DRAFT` | Taslak bir dosyaya bağlı değil; `content/` içinde sahipsiz dosya yok |
| 34 | `LNK-URL` | Bağlantılar geçerli HTTPS ve doğru platform alan adı |
| 35 | `LNK-REC` | Her bağlantı tek bir geçerli kayda ait |
| 36 | `ID-BASELINE` | Mevcut Work / Recording kimlikleri ve eşlemeleri korunuyor |
