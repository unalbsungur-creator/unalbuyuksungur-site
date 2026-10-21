#!/usr/bin/env python3
"""V2 müzik arşivinin güncel içerik bütünlüğü doğrulaması (yalnızca okur, hiçbir dosya yazmaz).

Görev 21'deki tek seferlik doğrulamanın (aktarım öncesi katalog yedeğine göre) sürdürülebilir hâli:
eski katalog durumunu beklemez, güncel onaylı durumu doğrular. Görev 25'ten beri: 68 bağımsız eser,
her eserde tek kayıt; ayrılan dört eser kaynak eserin söz/hikâye dosyasını paylaşır.

Her ortamda (yalnızca repo):
  katalog sayıları, eser–kayıt eşleşmeleri, içerik eşleşmeleri ve biçimi, onaylı içerik dosyalarının
  SHA-256 değerleri, WebP kapak dosyaları, açık konular.
--archive ile (yerel arşiv klasörü, repo dışı):
  sözler/hikâyeler kaynak Word belgesi ve onaylı metinlerle; katalog Görev 25 öncesi yedeğe göre;
  WebP'ler Görev 21 yedek manifestiyle.

Kullanım:
    python v2/music/tools/verify_content_integrity.py
    python v2/music/tools/verify_content_integrity.py --archive ../UNAL_MUSIC_ARCHIVE

Çıkış kodu: tüm kontroller PASS ise 0, aksi hâlde 1.
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True  # v2/ altında __pycache__ oluşmasın (herkese açık klasör)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from validate_catalog import RETIRED_CONTENT, SHARED_CONTENT  # noqa: E402  (kurallar tek yerde)

MUSIC_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = MUSIC_ROOT.parent.parent
CONTENT_PATH = re.compile(r"^content/(lyrics|stories)/[wr]-\d{4}\.txt$")
SOURCE_SHA256 = "e9151e8e283646c44a34eb9894203bb5dbad7e3ab7e6e223ac20a03d2a7fb3a0"
TASK25_BACKUP_CATALOG_SHA256 = "e7712b65921fc9cdd6b104409c885089f857e12ee5d2ebf298936fda65cc2e12"

# Görev 25 kullanıcı kararı: (kaynak eser, eserde kalan kayıt, ayrılan kayıt, yeni eser).
SPLITS = [
    ("w-0014", "r-0015", "r-0014", "w-0065"),  # Biliyorum: Pop | Rock Ballad
    ("w-0020", "r-0051", "r-0021", "w-0066"),  # Öyle Bir Şey (Akustik) | Böyle Bir Şey (Rock'n Roll)
    ("w-0056", "r-0059", "r-0058", "w-0067"),  # Turizmci | Turizmci (Pop Versiyon)
    ("w-0061", "r-0064", "r-0065", "w-0068"),  # Yenik Yüreğim: Pop | Thrash Metal
]
SLUGS = {"w-0020": "oyle-bir-sey", "w-0065": "biliyorum-rock-ballad-version", "w-0066": "boyle-bir-sey",
         "w-0067": "turizmci-pop-versiyon", "w-0068": "yenik-yuregim-thrash-metal-version"}
# Kayıt videoları: kayıt -> YouTube video kimliği (official-music-video). Kaynak yalnızca kanalın "Video Klip" oynatma
# listesi (49 video; yorumdaki # liste sırasıdır). Görev 36: r-0026 (ilk video). Görev 40: kalan 48 video, Görev 39
# envanteri ve kullanıcı kararlarıyla (ör. #7 -> Sonsuza Kadar, #29 -> Rock Ballad, #43 -> Pop). Katalogda bunlar dışında
# video olamaz; videosu olmayan 19 kayıtta alan yoktur.
VIDEO_DECISIONS = {
    "r-0003": "HNKMM9pfTJ8",  # #14 Angaralı Hasret
    "r-0004": "tVrZGaPSRTw",  # #49 Anneler Günü
    "r-0007": "TtxuK4xdhUU",  # #36 Babalar Günü
    "r-0010": "0BMN6o_hJUw",  # #48 Ben Boğa'yım
    "r-0011": "z5csFSoSli8",  # #6 Beni Sal
    "r-0012": "OYm6z7ehzKE",  # #41 Beni Yâr Seçtin
    "r-0013": "_ljZcwuJvWU",  # #4 Benimle Yaşlanacaktın
    "r-0014": "t_-m6kXBRzk",  # #29 Biliyorum (Rock Ballad Version)
    "r-0016": "MKnTF1jkwwY",  # #23 Bir Güzel Sevdim
    "r-0017": "-3WL0gfweKo",  # #9 Bir Kedim Var
    "r-0020": "O00SvlTK7UM",  # #25 Boşver Geç
    "r-0022": "1_uIKEFU5J8",  # #8 Bugün Benim Doğum Günüm
    "r-0023": "U4Y7UcDhEmY",  # #34 Çarpıldım Sana
    "r-0024": "PGvPgywoiWU",  # #32 Çat Çat Çat
    "r-0025": "KuogkPvK2PM",  # #42 Çekip Gittin
    "r-0026": "7c21yJVIsJc",  # #46 Çok Sevince İnsanı (Görev 36)
    "r-0027": "q1zwOKY3Ymk",  # #18 Du bist der Grund
    "r-0028": "ZUu-K_Qmli8",  # #10 Eksilmeyen
    "r-0029": "E5uvkGpOqTo",  # #3 Elimi Sıktın
    "r-0030": "kiMxnPIWF1Q",  # #26 Fishka
    "r-0031": "_huavYSid-8",  # #15 Gece Olunca
    "r-0032": "1_HWDHh0stg",  # #1 Günleri Saya Saya
    "r-0033": "fAmjDqgBOPU",  # #11 Haberleşiriz
    "r-0034": "wE9b3MR37IE",  # #17 Hafta
    "r-0035": "pklgS71VhRc",  # #44 Hasret Bitecek
    "r-0036": "m1RDa0-8338",  # #27 Haydi Dene
    "r-0037": "0tni7CybqP8",  # #39 Haziran
    "r-0038": "zTtH67AFB5U",  # #21 Ich meld' mich...
    "r-0040": "NDLHL_8sCZk",  # #31 Kabuğumu Bıraktım
    "r-0041": "wIMBBZnc7J0",  # #47 Kahve Falı
    "r-0043": "LUjBENG76ZA",  # #16 Kendimi Arıyorum
    "r-0044": "3Mcc6SnIrs4",  # #33 Kiminle
    "r-0047": "xZ5bDIskUVA",  # #20 Mutlu Yıllar
    "r-0048": "AqUwsEjYzaA",  # #24 Nerdesin
    "r-0049": "UmwBKxmgsFs",  # #35 Neredeyim Ben
    "r-0052": "G5RS_E5hmjE",  # #2 Sebebi Sensin
    "r-0053": "1kW3WenFU5o",  # #30 Seninle
    "r-0054": "1KhGHDbMMGQ",  # #7 Sonsuza Kadar (kullanıcı kararı; listedeki başlık "Galatasaray Marşı")
    "r-0055": "c2HxZlyjlmA",  # #40 Söz Verdim
    "r-0056": "aHjCAyxfZeI",  # #28 Tebessümler Yüzümde
    "r-0058": "F-mRzZU-2fI",  # #13 Turizmci (Pop Versiyon)
    "r-0059": "VaKBbcUp5RQ",  # #12 Turizmci (özgün kayıt)
    "r-0060": "H6MG3MK7oEc",  # #22 Türbülans
    "r-0061": "GvXRUO-vPsA",  # #19 Wegen Dir
    "r-0064": "L7TthTFzoWM",  # #43 Yenik Yüreğim (Pop Version)
    "r-0065": "n8tlmkgthQU",  # #45 Yenik Yüreğim (Thrash Metal Version)
    "r-0066": "oDxRo89ih-0",  # #37 Yine Üşüyorum
    "r-0067": "s84iajTL2aQ",  # #5 Yoksun Ama...
    "r-0068": "lJTRetMuCzk",  # #38 Yoksun
}
VIDEO_DECISIONS_UPDATED_AT = "2026-10-21"
# Görev 25 kullanıcı onaylı site hikâyesi düzeltmesi (Ağlama, w-0001; Word belgesi değişmedi).
AGLAMA_CORRECTION = ("content/stories/w-0001.txt",
                     "1998/ Flört bitince gözler kapaklarını açtığı ve damlalar gelmeye başladı",
                     "1998/ Flört bitince gözler kapaklarını açtı ve damlalar gelmeye başladı")
EXPECTED_OPEN_ISSUES = ["oi-0001", "oi-0002", "oi-0003", "oi-0004", "oi-0005", "oi-0006", "oi-0007", "oi-0008",
                        "oi-0010", "oi-0011"]

# Onaylı içerik (Görev 20–21; Görev 22–25'te doğrulandı): dosya baytlarının SHA-256 değeri.
# Görev 25: w-0001 hikâyesi Ağlama düzeltmesiyle güncellendi; r-0058/r-0065 artık bağlı değil (RETIRED_CONTENT).
# Bir söz veya hikâye bilinçli olarak değiştirildiğinde bu tablo da aynı değişiklikte güncellenmelidir.
CONTENT_SHA256 = {
    "content/lyrics/r-0058.txt": "d1c2bc2df7f0369a20fc0a253e88bc13ab7029882e6b2e94a5157f03f54ca0ba",
    "content/lyrics/r-0065.txt": "cfb8a38ceebf5f30cfb637498e7ea13cbf7185e4b7cfdabe7931dd46ec87ba52",
    "content/lyrics/w-0001.txt": "3705191112911fbd985b49d6b4b9cefc635aea7eacd4965832111e27dc808096",
    "content/lyrics/w-0002.txt": "ed857076b5e381bf493dbf2d4a8efc6b7d8478b3c5376134451f015f04eb4dac",
    "content/lyrics/w-0003.txt": "2a02fd17070f73c9699b2e46185229822488714dc2dad5a2acdf8d197bfebb75",
    "content/lyrics/w-0004.txt": "aad5ce35a779060e9d8d262c119caabfca6a35fa0f83a6013b7a392e85a4e6b9",
    "content/lyrics/w-0005.txt": "3579ffc6f44515b4f78b1da587c93bc4963b496516149b42d58a3284c1939731",
    "content/lyrics/w-0006.txt": "12e3ea58ba0755604997e3632bce4aa393d498ad79a2d2043c4d2c8a8dc54636",
    "content/lyrics/w-0007.txt": "6c1f14215e3aec4b6e8dfde3160940f4e79b0a51ad3c389ff87456c0dbd227fe",
    "content/lyrics/w-0008.txt": "1ad19388712df35482598b3bf827757b53b70029368c03b3de5e1829b4487dc1",
    "content/lyrics/w-0009.txt": "b67fb5794b1d8edd10904d10c76ea434788ada8b49ce7dd9f2cb885d6dc03026",
    "content/lyrics/w-0010.txt": "855ec7f63fa26ba381eece3f229c7d098efb77348b52f1ec936ae2fd6ec51af7",
    "content/lyrics/w-0011.txt": "5bcd2aaa3cc896707570a41d320192b2438107cc87ab4eab81e9d512590a117e",
    "content/lyrics/w-0012.txt": "9b5c1265a8f9064a2b9a3ddfebf49264f1f3c75bc18deb28ae3707cce59ee38c",
    "content/lyrics/w-0013.txt": "d32becb4da467197ca3753389aa683ca822913186fa6ede6f8a4a31a8c707cd5",
    "content/lyrics/w-0014.txt": "402a70791ca35e446abb4fc30825242d3260d2853e1359bb91e4cde58be114d3",
    "content/lyrics/w-0015.txt": "802d27edfa8741f4e306f1ffd36c464323da8952efbc04c4b33f2c8da486c46f",
    "content/lyrics/w-0016.txt": "a323421e768a5480bcb6de769e87a41ddf354520b6ef8689649b0982e85fd0fb",
    "content/lyrics/w-0017.txt": "2f5c9b53493e5e74318d622f0470fb77dfae03aef372c46c3126ccd523423646",
    "content/lyrics/w-0018.txt": "5413b689f08c81bbc97a02a0f9874049269b92bf9da603616cc07758fa2270b5",
    "content/lyrics/w-0019.txt": "ccbca9bf639c134ef391c434eb801b86850174caa9fd25ff3dde489ae091f2b5",
    "content/lyrics/w-0020.txt": "d614483c9a01c6f33df17f2624f0be4378b599c5b4e8ac087f5a0f3d05c53f8f",
    "content/lyrics/w-0021.txt": "263536cfdc68110a28d73464981349fd4243ab2ee4ec3b13b0474af348a597cf",
    "content/lyrics/w-0022.txt": "ae049800e429796114a3f07aec081a0b4e62cff773b0f6aa322d3968e7c7e81a",
    "content/lyrics/w-0023.txt": "ba50c747b5bc3acd3f389cc32c80092a32410b3d3181f5eff34956a7972fba91",
    "content/lyrics/w-0024.txt": "3aced9467a6c15c61bd46894794a1d35e439ec2c7b4a6bbd5a4ffe1dc7dbc170",
    "content/lyrics/w-0025.txt": "fff559b68c5c426e226305e4035e4270a11c1e08002f0e46a7a317a4d0d496ba",
    "content/lyrics/w-0026.txt": "d247080408facb1bddf5d5dfbef7fbd768b2e8d0180a6632926666afe6d225bb",
    "content/lyrics/w-0027.txt": "b51a2f99d8ed55e2f2af09d678eaf6fd505e2015c44609066c88e114e184c8cd",
    "content/lyrics/w-0028.txt": "4c3bd46a3a3072da2d1690d0f3cbde4e70c8cac9eebd848971239773d85dd615",
    "content/lyrics/w-0029.txt": "8614fdd99ac217e0172526b50d8c4f0f21fa40ce2a4a6ec276fa3158e0e934dd",
    "content/lyrics/w-0030.txt": "baf7f7e044a959d05dea6cbcf32541a6d5bd8efbd6947a8bc4eb55f6a6ad1f9c",
    "content/lyrics/w-0031.txt": "328434fe41b43449e3023fa3aa4f79d3552c29ede525cf4cbf7f5414184167ae",
    "content/lyrics/w-0032.txt": "5ac2282f62b7e470e4c6ea17d3a09fe32e5cc40689b942b9f1212d9cb3701eff",
    "content/lyrics/w-0033.txt": "146656e3d3d99bcb49a0d8f6ee4997e60a2ad3dff6d8997daeb3c310a25459f0",
    "content/lyrics/w-0034.txt": "18ed08b401f7676a3ccc805dadd1ddc844e796348a07d52677eb7ca830de9cfb",
    "content/lyrics/w-0035.txt": "ad57073e33e432a0fe2168ce6f156f1254a7374ab0134a99dd49ba2f19445f47",
    "content/lyrics/w-0036.txt": "2277c5d95317cd7c504f8d15473c8ae4b727e918c60333bf96bdfdb5b0a6bc4f",
    "content/lyrics/w-0037.txt": "70c37f4cc2b9e2ce5ea1eabfc2752c81feac4adc8b4a9e53584a5d4a970d457e",
    "content/lyrics/w-0038.txt": "6b96e560c074c0720652bc919da9e9a1c069346dde974e57fbadd9aa31387dc4",
    "content/lyrics/w-0039.txt": "efcbdb80da9c01f6674a40fb7b21dbf86683610866cf6e9fb26d357819508fff",
    "content/lyrics/w-0040.txt": "f3244739a84cd32c3f0d5467a5bbf91198d86126147207c4e2128e066d7a31ab",
    "content/lyrics/w-0041.txt": "b48b285f423d419e0acae9ba1b13f37025900b85d076c52948904733ef6a051f",
    "content/lyrics/w-0042.txt": "70ca2734845cb01535e560dadd39ce6a012a8f82f900ab26e7cb1336aa5f2a9d",
    "content/lyrics/w-0043.txt": "08f1d092cd245efb023afac60e8b254cc8e4f35ccfecec61dbda017ab44a6463",
    "content/lyrics/w-0044.txt": "891f6e4fcb2e46dad5d424e686a2aa9e01d6684f37accc73ef9bba0cf14e54da",
    "content/lyrics/w-0045.txt": "f5a6db54103b4738274e71ed2af78e5f279cb6add819529bbdcc0c0b94da6148",
    "content/lyrics/w-0046.txt": "f6f8ce27b1c8f4ab34fac1861f9b2554bfbf8dc7a76c9de3250c7e9ea189a54f",
    "content/lyrics/w-0047.txt": "68be77f962ecfd7a1d0cebcfc9042e8082533d9f56c2323a5d5914c1ba7eebba",
    "content/lyrics/w-0048.txt": "71a045d3d9c35d3a14864450d7e8406bce5815c04525fe2edace0fdbd0db6780",
    "content/lyrics/w-0049.txt": "c99f2c176bdc9da1548abbe6f8d4ee982beb59f96a2380745bba2caa6eabe38e",
    "content/lyrics/w-0050.txt": "d65586b1add02392e530a913fb83dc29c3ffe78a5eccbb6fc2a47cb28305e4c0",
    "content/lyrics/w-0051.txt": "2f95dc1d3fb9941d1ce6cc509c6f6b69123d70db8fd06ba67fef412884663d81",
    "content/lyrics/w-0052.txt": "683d7e6504d8c56e719c4df9af780602f7b7f5e9366e19dfb667376461ce2353",
    "content/lyrics/w-0053.txt": "52911ed96a3ac2d3349f42a7483df24cf32bbd89f069ba52847a41d5df6ba3e5",
    "content/lyrics/w-0054.txt": "2ce15d92aae7d17349e896904c6ddd79191b3ace861354a76965189af960d895",
    "content/lyrics/w-0055.txt": "69793450dbf8d41338b5e9700da8f66ec358484210043977623d789423401a63",
    "content/lyrics/w-0056.txt": "6564acd910faf6b9c1b8f90edc3aa9fda82fe4c5d3298b3c13e85ae2672fdf45",
    "content/lyrics/w-0057.txt": "e65a9186356eccebf78b911023a87f8e1d4d099c377448c362911b40c258f240",
    "content/lyrics/w-0058.txt": "323df600b7fa99b16efa5c7c6b6de427c9a66748e5028a0415b26a6c2983002a",
    "content/lyrics/w-0059.txt": "2c01d60c24a0705907bd333095626cb3a18e1798df404d06e7aa6caa5152b833",
    "content/lyrics/w-0060.txt": "7443319ab70b5e15b298d491189534fb1b6f77917e9eed55f858d4145c30b6e9",
    "content/lyrics/w-0061.txt": "ef6d179fa00ebdeb66362afecf5b1ebbe43558e81f88dee5835f71b139ee147a",
    "content/lyrics/w-0062.txt": "0de4777dc700b04d15f47dcfb8e3b99239ee543873520f3105dd783f3f1854e9",
    "content/lyrics/w-0063.txt": "40e7af978802747e50e45f118220dad8a8a1a12b3b6812e653c46ffe5d93bb80",
    "content/lyrics/w-0064.txt": "da60766883120dfb20bfafeb2a5af984a64ea49a3c1ba094dac0d9e4436da74e",
    "content/stories/w-0001.txt": "b71478171f767533f0b81689231800ca1fe35347a08e085441a26935b6daf5e6",
    "content/stories/w-0002.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0003.txt": "8738a4a7d8d376342ccfd9c862410a1863ca564aebfb900d128b17691d9980e7",
    "content/stories/w-0004.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0005.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0006.txt": "2ee19dea44fdc955e821fcf82219ad6b8f3a15ec8d9b8f79b499d7ab91866f20",
    "content/stories/w-0007.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0008.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0009.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0010.txt": "c68c2d7a113ff3359109ad8baf3db5eae2c08b8c28cf20f7d410ab5607d4800f",
    "content/stories/w-0011.txt": "2fb9d0af9cb0a2a457f82c6159f5fb1478ab6dc73e7a4b1fea16b6e84b5cc3ef",
    "content/stories/w-0012.txt": "345b579c08e76ce3017167f303d8494495ad5d6a4d5cd882f7e12b4903b144e8",
    "content/stories/w-0013.txt": "97c280113386ec919f100a6bb3bdfa923d29e00084479e69422113261ad97181",
    "content/stories/w-0014.txt": "86355ea284896e82ca882a64f53280777ad4dab8e05001f8e56926772d2fae21",
    "content/stories/w-0015.txt": "b4c525e45127ba3492c11b6e716bdb78759376662b9b2f7e8879620ce15733ad",
    "content/stories/w-0016.txt": "c3f18e290a903ef4571e72ce2d777ff444cf32d2f9c1d901197cd17f3fbc8926",
    "content/stories/w-0017.txt": "9c2e329e71f07393bda21c81174d191d5d06a234ea8eab929058e054ed0ee714",
    "content/stories/w-0018.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0019.txt": "c537f78f67ccdf1ee79bd3363118565ae328709081cc13432c7452e5228596b3",
    "content/stories/w-0020.txt": "46d6b943022f0ff227b4052dbe0d4d4c1095e4c362b6a78e93af52ffa1f4f112",
    "content/stories/w-0021.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0022.txt": "9906cd80bc74addd45c124267d8db3a9c26fb17e53dc08b48aefebc241c044a4",
    "content/stories/w-0023.txt": "0600f8c7058f73d6727619fa545b55eeeccc39d39bb098f7d5440e51de317edd",
    "content/stories/w-0024.txt": "2a59926f84f2fda323066e20cfae34909f19e767813679173ec054dcfb47f117",
    "content/stories/w-0025.txt": "64f1775d37b54db7720ca6a17352cfbcf23cf172df712ed317add36c163a7413",
    "content/stories/w-0026.txt": "db3c230c0023a0f63eaf323b31918631e41eb5076da40cc527cf43928da1de9b",
    "content/stories/w-0027.txt": "67ae58c5a743c86234446982416923f2d498eddbf21017eaf841a23f84e4c672",
    "content/stories/w-0028.txt": "0e53f5f4da40dec9b1d68ffdce9e33355cc2a9bc5ae7907720bfdc1df61f2c5d",
    "content/stories/w-0029.txt": "304702c39225c4a8b331b5fbf6f0e15994ded0c5d04a1685d8130480a03e962f",
    "content/stories/w-0030.txt": "598bdf8b1b289a0539fc805f7b5efd8b6073963919cef50f6d8b995d20fc9147",
    "content/stories/w-0031.txt": "18ac8de013209dc44caa4070a2eabb0a0500e1f844b0740bc48aa9a6f7d1822a",
    "content/stories/w-0032.txt": "145abe90721282f352fa27443b7edfecf286186f69a03aaee4535f78a85dd094",
    "content/stories/w-0033.txt": "14ebccad88c55d919576084f1578c127121c34b83cb7d88d594cd08174688a39",
    "content/stories/w-0034.txt": "e809c9c16be6963f1dbff6f6175d458929c83cb078d0086a268e796075ed41e9",
    "content/stories/w-0035.txt": "6390b8cf1bb5622860ffba4949569f9dcb94f7a8d4e05bb511af8a8031fe671b",
    "content/stories/w-0036.txt": "1e28cc7b693acc2d507413583a865cdba98ad17b1ea0895b22c8e71442c3fc8a",
    "content/stories/w-0037.txt": "1ee0e47dcb38824d01d6dde730e8abc4dd385de7c3ec45f1cf394e7a661456e7",
    "content/stories/w-0038.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0039.txt": "b77769547c1b8698c503b4594d12bb9a970bd1422b033bb8141ff57add572ea1",
    "content/stories/w-0040.txt": "ced425886f973e7b748ed5732485c6bc743d20470c09a5aa5f4fd8efd20891a3",
    "content/stories/w-0041.txt": "b51752e15772c74f2d871002efbc7a7b32b8e776f7a2779c45616cba1eea5d35",
    "content/stories/w-0042.txt": "d30991bc44eb7a2e45be5e60104d7c25db12ace877f9a025e500fdf9436e441a",
    "content/stories/w-0043.txt": "e67a907e0cc590dce0048598283e24e07187af7c699295adaf86f5b9ead96afc",
    "content/stories/w-0044.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0045.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0046.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0047.txt": "5880103abc913117f7e11e832d6a6296cf5a97e0d6ea7ddd411635465898e464",
    "content/stories/w-0048.txt": "4579e8cc13ec43669fb6421ed7bd63dc63ecad8f0cdeed96bc615b5f69b67741",
    "content/stories/w-0049.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0050.txt": "4ecb28043d2425c0fb32c626a15fb9de721e88e30286308ba9152a3e1b53d912",
    "content/stories/w-0051.txt": "5e1b79e0f0c1968e3f5d2d00f9ee6372f8140e97b2dfb9dbb066200781f9d379",
    "content/stories/w-0052.txt": "7e1cb4a994178061d15120e0ef2d4feed881ba24a04e483298d1a349de0d26fb",
    "content/stories/w-0053.txt": "55a2785c647fa8304c4a87ebb47be1e237111c231d98876e66e30ff546b4f08c",
    "content/stories/w-0054.txt": "76d9de2d15cb686f50f75668cdaa25a02422cb2520148ed011101b4fc693cb13",
    "content/stories/w-0055.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0056.txt": "168c6dcfea5e4d48f719bae0e235265c46630dd239a059fbc6eb37309cfbeb80",
    "content/stories/w-0057.txt": "a651e58780e95a4c75044453d250b17820617c7009c6a41abf3d57cfe32a7af2",
    "content/stories/w-0058.txt": "84ff7d7453ec741d05d776d56c363543cdd3edddd7b3f38d129c04a1c72f9327",
    "content/stories/w-0059.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0060.txt": "a42327a250fd1e130bd014d99af701c0457791b16684368acf23c144b493f025",
    "content/stories/w-0061.txt": "baeadea19880b19fe518646986fd260bf9bd9f4b5816b6cac1d368f4af319622",
    "content/stories/w-0062.txt": "cf49b5b5a67d09106cd3396d17851adabdf4c9cd1ad20c1e1dc4f325953fa32f",
    "content/stories/w-0063.txt": "b02eccecadcfdac1d515cd4c34a3405f4bd7dee5078de09c00f6c83639ecc9b7",
    "content/stories/w-0064.txt": "e914551f8e6336ede569a0df906c479f2eb4922208492d136f43185ff3ae6fac"
}


class Report:
    def __init__(self):
        self.rows = []

    def check(self, label, problems):
        self.rows.append((label, list(problems)))

    def ok(self):
        return all(not problems for _, problems in self.rows)

    def print(self):
        for no, (label, problems) in enumerate(self.rows, 1):
            print(f"[{'PASS' if not problems else 'FAIL'}] {no:>2}. {label}")
            for problem in problems[:10]:
                print(f"         - {problem}")
            if len(problems) > 10:
                print(f"         - … {len(problems) - 10} sorun daha")
        passed = sum(1 for _, problems in self.rows if not problems)
        print(f"\nToplam: {len(self.rows)} kontrol, {passed} PASS, {len(self.rows) - passed} FAIL")


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def expected_split_catalog(before):
    """Görev 25 öncesi katalogdan beklenen sonucu üretir (yalnızca karşılaştırma için)."""
    data = json.loads(json.dumps(before))
    works = {w["id"]: w for w in data["works"]}
    recordings = {r["id"]: r for r in data["recordings"]}
    works["w-0020"].update(title="Öyle Bir Şey", titleStatus="confirmed", workingTitle=None, slug=SLUGS["w-0020"])
    for source, _keep, move, new in SPLITS:
        data["works"].append(dict(works[source], id=new, title=recordings[move]["title"], titleStatus="confirmed",
                                  workingTitle=None, slug=SLUGS[new]))
        recordings[move]["workId"] = new
        recordings[move].pop("lyrics", None)
    data["works"].sort(key=lambda w: w["id"])
    return data


def apply_later_decisions(data):
    """Görev 25'ten sonra onaylanan katalog kararlarını ekler (Görev 36 ve 40: kayıt videoları)."""
    data = json.loads(json.dumps(data))
    for recording in data["recordings"]:
        if recording["id"] in VIDEO_DECISIONS:
            recording["videos"] = [{"provider": "youtube", "videoId": VIDEO_DECISIONS[recording["id"]],
                                    "videoType": "official-music-video"}]
    data["updatedAt"] = VIDEO_DECISIONS_UPDATED_AT
    return data


def repo_checks(report, catalog):
    works = {w["id"]: w for w in catalog["works"]}
    recordings = {r["id"]: r for r in catalog["recordings"]}
    covers = {c["id"]: c for c in catalog["covers"]}

    counts = {"Work": (len(works), 68), "Recording": (len(recordings), 68), "CoverAsset": (len(covers), 68)}
    report.check("Katalog: 68 Work, 68 Recording, 68 CoverAsset",
                 [f"{k}: {got} (beklenen {want})" for k, (got, want) in counts.items() if got != want])

    problems = []
    per_work = {wid: [r["id"] for r in recordings.values() if r["workId"] == wid] for wid in works}
    problems += [f"{wid}: {ids}" for wid, ids in per_work.items() if len(ids) != 1]
    problems += [f"{rid}: eser yok ({r['workId']})" for rid, r in recordings.items() if r["workId"] not in works]
    for source, keep, move, new in SPLITS:
        if per_work.get(source) != [keep] or per_work.get(new) != [move]:
            problems.append(f"{source}/{new}: {per_work.get(source)} / {per_work.get(new)} (beklenen [{keep}] / [{move}])")
        elif works[new]["title"] != recordings[move]["title"] or works[new]["slug"] != SLUGS[new]:
            problems.append(f"{new}: başlık/slug {works[new]['title']!r}/{works[new]['slug']!r}")
    if works["w-0020"]["title"] != recordings["r-0051"]["title"] or works["w-0020"]["slug"] != SLUGS["w-0020"]:
        problems.append("w-0020 başlığı/slug'ı 'Öyle Bir Şey'/'oyle-bir-sey' değil")
    if any(recordings[r]["isOriginal"] is not None or recordings[r]["genres"] for r in ("r-0051", "r-0021")):
        problems.append("Öyle/Böyle kayıtlarında doğrulanmamış isOriginal/tür atanmış (oi-0001)")
    slugs = [w["slug"] for w in works.values() if w["slug"]]
    if len(slugs) != len(set(slugs)):
        problems.append("slug tekrarı var")
    for js in (MUSIC_ROOT / "work" / "work.js", MUSIC_ROOT / "catalog.js"):
        if "DEFAULT_RECORDINGS" in js.read_text(encoding="utf-8"):
            problems.append(f"{js.name}: tek kayıtlı eserlerde DEFAULT_RECORDINGS gereksiz")
    report.check("Eser–kayıt: 68 eserin her birinde tam 1 kayıt; ayrılan 8 eser doğru kayıt, başlık ve slug'da", problems)

    problems = []
    for wid, work in works.items():
        for field, folder in (("lyrics", "lyrics"), ("story", "stories")):
            owner = SHARED_CONTENT.get(wid, wid)
            if work[field] != {"status": "published", "file": f"content/{folder}/{owner}.txt"}:
                problems.append(f"{wid}.{field} = {work[field]}")
    if SHARED_CONTENT != {new: source for source, _k, _m, new in SPLITS}:
        problems.append(f"SHARED_CONTENT Görev 25 kararıyla aynı değil: {SHARED_CONTENT}")
    problems += [f"{rid}: recording.lyrics = {r['lyrics']}" for rid, r in recordings.items() if "lyrics" in r]
    report.check("68 eserin sözü ve hikâyesi yayımlanmış; kendi dosyasına ya da onaylı ortak dosyaya bağlı; "
                 "kayda özel söz yok", problems)

    referenced = {w[f]["file"] for w in works.values() for f in ("lyrics", "story")}
    on_disk = {p.relative_to(MUSIC_ROOT).as_posix() for p in (MUSIC_ROOT / "content").rglob("*") if p.is_file()}
    lyrics = sorted(f for f in on_disk if f.startswith("content/lyrics/"))
    stories = sorted(f for f in on_disk if f.startswith("content/stories/"))
    problems = [f"referanssız: {f}" for f in sorted(on_disk - referenced - set(RETIRED_CONTENT))]
    problems += [f"eksik: {f}" for f in sorted(referenced - on_disk)]
    problems += [f"emekli dosya katalogda bağlı: {f}" for f in sorted(referenced & set(RETIRED_CONTENT))]
    problems += [f"emekli dosya yok veya değişmiş: {f}" for f, h in RETIRED_CONTENT.items()
                 if f not in on_disk or sha256(MUSIC_ROOT / f) != h]
    problems += [f"geçersiz yol: {f}" for f in sorted(on_disk) if not CONTENT_PATH.match(f)]
    if (len(lyrics), len(stories), len(referenced)) != (66, 64, 128):
        problems.append(f"{len(lyrics)} söz / {len(stories)} hikâye dosyası, {len(referenced)} bağlı dosya "
                        "(beklenen 66 / 64, 128)")
    report.check("content/: 66 söz + 64 hikâye dosyası; 128'i bağlı, 2 eski versiyon sözü değişmeden duruyor", problems)

    problems = []
    for f in sorted(on_disk):
        data = (MUSIC_ROOT / f).read_bytes()
        if data.startswith(b"\xef\xbb\xbf"):
            problems.append(f"{f}: BOM")
        if b"\r" in data:
            problems.append(f"{f}: CR satır sonu")
        if not data.endswith(b"\n") or data.endswith(b"\n\n") or not data.strip():
            problems.append(f"{f}: son satır sonu / boş")
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            problems.append(f"{f}: UTF-8 değil")
    report.check("İçerik dosyaları UTF-8 (BOM'suz), LF, tek son satır sonu, boş değil", problems)

    problems = [f"{f}: değişmiş" for f, h in CONTENT_SHA256.items() if (MUSIC_ROOT / f).is_file() and sha256(MUSIC_ROOT / f) != h]
    problems += [f"{f}: tabloda yok" for f in sorted(on_disk - set(CONTENT_SHA256))]
    problems += [f"{f}: dosya yok" for f in sorted(set(CONTENT_SHA256) - on_disk)]
    report.check("130 onaylı söz/hikâye dosyası bayt bayt aynı (SHA-256)", problems)

    def text(f):
        return (MUSIC_ROOT / f).read_text(encoding="utf-8")
    problems = []
    for source, _keep, _move, new in SPLITS:
        for field in ("lyrics", "story"):
            if works[new][field] != works[source][field]:
                problems.append(f"{new}.{field} ≠ {source}.{field}")
    file, old, corrected = AGLAMA_CORRECTION
    if text(file).count(corrected) != 1 or old in text(file):
        problems.append("Ağlama (w-0001) hikâyesinde onaylı düzeltme yok")
    zodiac = [m["workId"] for c in catalog["collections"] if c["slug"] == "burc-serisi" for m in c["members"]]
    zodiac_stories = {text(f"content/stories/{w}.txt") for w in zodiac}
    if len(zodiac) != 12 or len(zodiac_stories) != 1:
        problems.append(f"burç serisi: {len(zodiac)} eser, {len(zodiac_stories)} farklı hikâye (beklenen 12 / 1)")
    report.check("Ayrılan eser çiftleri aynı söz ve hikâyeyi paylaşıyor; Ağlama düzeltmesi var; "
                 "12 burç eserinde tek ortak hikâye", problems)

    images = {p.relative_to(MUSIC_ROOT).as_posix() for p in (MUSIC_ROOT / "images").glob("*.webp")}
    used = {i["path"] for c in covers.values() for i in c["webImages"]}
    problems = [f"referanssız: {p}" for p in sorted(images - used)] + [f"eksik: {p}" for p in sorted(used - images)]
    problems += [f"{rid}: kapak yok ({r['coverId']})" for rid, r in recordings.items() if r["coverId"] not in covers]
    cover_ids = [r["coverId"] for r in recordings.values()]
    if len(cover_ids) != len(set(cover_ids)):
        problems.append("aynı kapak birden fazla kayda bağlı")
    for p in sorted(images & used):
        head = (MUSIC_ROOT / p).read_bytes()[:12]
        if head[:4] != b"RIFF" or head[8:12] != b"WEBP":
            problems.append(f"{p}: WebP başlığı yok")
    if len(images) != 204:
        problems.append(f"{len(images)} WebP (beklenen 204)")
    report.check("204 WebP geçerli ve kapaklarda referanslı; her kaydın kendi kapağı var", problems)

    ids = [o["id"] for o in catalog["openIssues"]]
    problems = [] if ids == EXPECTED_OPEN_ISSUES else [f"açık konular: {ids}"]
    report.check("Açık konular: 10; oi-0009 kapalı, oi-0001 ve oi-0008 açık", problems)

    # Kayıt videoları onaylı kararlarla birebir: yanlış/eksik/fazla/yinelenen video ya da yanlış kayıt (versiyon) FAIL.
    problems = []
    for rid, recording in sorted(recordings.items()):
        expected = ([{"provider": "youtube", "videoId": VIDEO_DECISIONS[rid], "videoType": "official-music-video"}]
                    if rid in VIDEO_DECISIONS else None)
        if recording.get("videos") != expected:
            problems.append(f"{rid}: videos = {recording.get('videos')!r}, beklenen {expected!r}")
    problems += [f"{rid}: onaylı kayıt katalogda yok" for rid in VIDEO_DECISIONS if rid not in recordings]
    if len(set(VIDEO_DECISIONS.values())) != len(VIDEO_DECISIONS):
        problems.append("onaylı kararlarda yinelenen video kimliği")
    report.check(f"Kayıt videoları onaylı {len(VIDEO_DECISIONS)} kararla birebir; videosuz "
                 f"{len(recordings) - len(VIDEO_DECISIONS)} kayıtta alan yok", problems)


def archive_checks(report, catalog, archive):
    import import_song_archive as isa  # noqa: E402

    reports = archive / "reports"
    # Kaynak belge adıyla değil, onaylı SHA-256 değeriyle bulunur (arşivin incoming/ klasöründe).
    source = next((p for p in sorted((archive / "incoming").glob("*.docx")) if sha256(p) == SOURCE_SHA256), None)
    if source is None:
        report.check("Kaynak Word belgesi onaylı sürüm", ["incoming/ klasöründe onaylı SHA-256 ile .docx bulunamadı"])
        return
    report.check("Kaynak Word belgesi onaylı sürüm", [])
    paragraphs, _ = isa.read_archive(source)
    sections = {s["section"]: s for s in isa.split_sections(paragraphs)[0]}
    task14 = json.loads((reports / "task-14" / "manifest.json").read_text(encoding="utf-8"))["sections"]

    def body(f):
        return (MUSIC_ROOT / f).read_text(encoding="utf-8").rstrip("\n")

    file, old, corrected = AGLAMA_CORRECTION

    def as_imported(f):
        # Görev 21'de aktarılan metin: Ağlama düzeltmesi geri alınarak karşılaştırılır.
        return body(f).replace(corrected, old) if f == file else body(f)
    manifest = json.loads((reports / "task-21" / "content-import-manifest.json").read_text(encoding="utf-8"))
    problems = [e["file"] for e in manifest["lyrics"] + manifest["stories"]
                if hashlib.sha256(as_imported(e["file"]).encode("utf-8")).hexdigest() != e["sha256"]]
    if len(manifest["lyrics"]) + len(manifest["stories"]) != 130:
        problems.append("Görev 21 manifesti 130 kayıt içermiyor")
    aglama = next(e["source_section"] for e in task14 if e["work_id"] == "w-0001")
    word_story = sections[aglama]["story"]
    if old not in word_story or body(file) != word_story.replace(old, corrected):
        problems.append("Ağlama hikâyesi Word metninden yalnızca onaylı ifadeyle ayrılmıyor")
    report.check("130 dosya Görev 21 aktarım manifestiyle aynı; tek fark Ağlama düzeltmesi (Word'e göre de tek ifade)",
                 problems)

    s = sections
    problems = [k for k, ok in {
        "w-0056 = bölüm 41": body("content/lyrics/w-0056.txt") == s[41]["lyrics"],
        "r-0058 (eski, bağlı değil) = bölüm 45": body("content/lyrics/r-0058.txt") == s[45]["lyrics"],
        "w-0061 = bölüm 34": body("content/lyrics/w-0061.txt") == s[34]["lyrics"],
        "r-0065 (eski, bağlı değil) = bölüm 22": body("content/lyrics/r-0065.txt") == s[22]["lyrics"],
        "w-0014 = bölüm 3 = bölüm 38": body("content/lyrics/w-0014.txt") == s[3]["lyrics"] == s[38]["lyrics"],
        "w-0020 = bölüm 55 = bölüm 56": body("content/lyrics/w-0020.txt") == s[55]["lyrics"] == s[56]["lyrics"],
        "w-0020 hikâye = Akustik bölüm 55": body("content/stories/w-0020.txt") == s[55]["story"],
    }.items() if not ok]
    report.check("Ayrılan eserlerin ortak söz/hikâyesi ve eski versiyon sözleri Word bölümleriyle birebir", problems)

    overrides = {o["work_id"]: o["story_text"] for o in
                 json.loads((reports / "task-20" / "approved-story-overrides.json").read_text(encoding="utf-8"))["overrides"]}
    v3 = (reports / "task-19" / "sonsuzakadar-public-story-v3.txt").read_text(encoding="utf-8").rstrip("\n")
    problems = [wid for wid, story in overrides.items() if body(f"content/stories/{wid}.txt") != story]
    # v3 ile birebir eşitlik, gizlilik için çıkarılan ifadelerin bulunmadığını da kanıtlar (ifadeler burada tekrarlanmaz).
    if body("content/stories/w-0052.txt") != v3:
        problems.append("w-0052 ≠ v3")
    if "giderken  Döşmealtı" not in body("content/stories/w-0019.txt") or "be kamu spotu" not in body("content/stories/w-0019.txt"):
        problems.append("w-0019 özgün yazım (çift boşluk / 'be kamu spotu') yok")
    report.check("Onaylı düzeltilmiş hikâyeler: w-0052 v3, w-0010, w-0019, w-0041", problems)

    problems = [f for f, name in (("content/lyrics/w-0025.txt", "cok-sevince-insani-final-lyrics.txt"),
                                  ("content/stories/w-0025.txt", "cok-sevince-insani-final-story.txt"))
                if (MUSIC_ROOT / f).read_bytes() != (reports / "task-20" / name).read_bytes()]
    report.check("Çok Sevince İnsanı (w-0025) Görev 20 son dosyalarıyla bayt bayt aynı", problems)

    zodiac = [m["workId"] for c in catalog["collections"] if c["slug"] == "burc-serisi" for m in c["members"]]
    problems = [w for w in zodiac if body(f"content/stories/{w}.txt") != isa.ZODIAC_STORY]
    if body("content/lyrics/w-0017.txt") != s[54]["lyrics"] or body("content/stories/w-0017.txt") != s[54]["story"]:
        problems.append("w-0017 Word bölüm 54 ile aynı değil")
    report.check("Burç serisi ortak hikâyesi (12) ve Biten Sadece Zaman (w-0017) Word ile birebir", problems)

    special = {"w-0056", "w-0061", "w-0021", "w-0025"}
    problems = [e["work_id"] for e in task14
                if e["work_id"] not in special and body(f"content/lyrics/{e['work_id']}.txt") != s[e["source_section"]]["lyrics"]]
    last = s[39]["lyrics"].split("\n")[-1]
    if body("content/stories/w-0021.txt") != last or last in body("content/lyrics/w-0021.txt"):
        problems.append("w-0021 son satırı hikâyede değil")
    report.check("Diğer eserlerin sözleri Word bölümleriyle birebir; w-0021 ayrımı korunuyor", problems)

    # Görev 25 öncesi yedek (Görev 24'te 19/19 doğrulanan durum) + ayırma kararı = güncel katalog.
    before_path = archive / "backups" / "task-25" / "v2" / "music" / "data" / "catalog.json"
    problems = []
    if sha256(before_path) != TASK25_BACKUP_CATALOG_SHA256:
        problems.append("Görev 25 yedek kataloğu beklenen sürüm değil")
    expected = apply_later_decisions(expected_split_catalog(json.loads(before_path.read_text(encoding="utf-8"))))
    problems += [key for key in sorted(set(expected) | set(catalog)) if expected.get(key) != catalog.get(key)]
    report.check("Katalog = Görev 25 öncesi yedek + ayırma kararı + onaylı 49 video kararı (başka hiçbir fark yok)",
                 problems)

    backup = {}
    for line in (archive / "backups" / "task-21" / "v2-sha256-manifest.txt").read_text(encoding="utf-8").strip().splitlines():
        digest, path = line.split(" *", 1)
        backup[path.strip()] = digest.strip()
    webp = {p: h for p, h in backup.items() if p.startswith("v2/music/images/") and p.endswith(".webp")}
    problems = [p for p, h in webp.items() if sha256(REPO_ROOT / p) != h]
    if len(webp) != 204:
        problems.append(f"yedekte {len(webp)} WebP")
    report.check("204 WebP Görev 21 yedek manifestiyle bayt bayt aynı", problems)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--archive", type=Path, help="UNAL_MUSIC_ARCHIVE klasörü (kaynak Word, onaylı metinler, yedekler)")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    catalog = json.loads((MUSIC_ROOT / "data" / "catalog.json").read_text(encoding="utf-8"))
    report = Report()
    repo_checks(report, catalog)
    if args.archive:
        archive_checks(report, catalog, args.archive)
    else:
        print("Not: --archive verilmedi; Word ve onaylı metin karşılaştırmaları atlandı.\n")
    report.print()
    return 0 if report.ok() else 1


if __name__ == "__main__":
    sys.exit(main())
