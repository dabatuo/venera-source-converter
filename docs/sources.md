# 已收录漫画源

当前项目包含以下 Venera 漫画源：

| 文件名 | 源名称 |
| --- | --- |
| `copy_manga.js` | 拷贝漫画 |
| `manga_dex.js` | MangaDex |
| `nhentai.js` | nhentai |
| `picacg.js` | Picacg |
| `komiic.js` | Komiic |
| `baozi.js` | 包子漫画 |
| `comick.js` | comick |
| `manhuagui.js` | 漫画柜 |
| `shonen_jump_plus.js` | 少年ジャンプ＋ |
| `ikmmh.js` | 爱看漫 |
| `goda.js` | GoDa漫画 |
| `manhuaren.js` | 漫画人 |
| `jm.js` | 禁漫天堂 (JMComic) |

## 添加新源

将 Venera 的 `.js` 源文件放入 `sources/` 目录后，调用 `POST /reload` 即可热加载；重新部署后也会在启动时自动加载。
