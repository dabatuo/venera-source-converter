const express = require("express");
const VeneraRuntime = require("./venera-runtime");
const axios = require("axios");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");
const { injectSpeedInsights } = require("@vercel/speed-insights");

process.on("uncaughtException", (error) => {
  console.error("=== 未捕获的异常 ===");
  console.error("时间:", new Date().toISOString());
  console.error("错误名称:", error.name);
  console.error("错误信息:", error.message);
  console.error("错误堆栈:", error.stack);
  console.error("====================");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("=== 未处理的 Promise 拒绝 ===");
  console.error("时间:", new Date().toISOString());
  console.error("拒绝原因:", reason);
  console.error("Promise:", promise);
  console.error("============================");
});

const app = express();
const runtime = new VeneraRuntime();

// 辅助函数：构建基础 URL
function getBaseUrl(req) {
  let protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.get("host");
  let cleanHost = host;

  if (host.includes(":")) {
    const [hostname, port] = host.split(":");
    // 如果端口是 443，强制协议为 https 并移除端口
    if (port === "443") {
      protocol = "https";
      cleanHost = hostname;
    }
    // 如果端口是 80，强制协议为 http 并移除端口
    else if (port === "80") {
      protocol = "http";
      cleanHost = hostname;
    }
  }

  return `${protocol}://${cleanHost}`;
}

// 漫画源文件目录
const SOURCES_DIR = path.join(__dirname, "sources");

// 图片处理并发限制
const MAX_CONCURRENT_IMAGE_REQUESTS = 5;
const MAX_QUEUE_SIZE = 50;
let activeImageRequests = 0;
const imageRequestQueue = [];

function processNextImageRequest() {
  if (
    activeImageRequests < MAX_CONCURRENT_IMAGE_REQUESTS &&
    imageRequestQueue.length > 0
  ) {
    const nextRequest = imageRequestQueue.shift();
    processImageRequest(nextRequest.req, nextRequest.res);
  }
}

async function processImageRequest(req, res) {
  const startTime = Date.now();
  const requestId = Math.random().toString(36).substring(7);
  const queueIndex = imageRequestQueue.findIndex((item) => item.req === req);
  if (queueIndex !== -1) {
    imageRequestQueue.splice(queueIndex, 1);
  }

  console.log(
    `[图片请求 ${requestId}] 开始处理 - URL: ${req.query.url?.substring(0, 50)}...`,
  );

  try {
    activeImageRequests++;

    let imageUrl = req.query.url;
    if (!imageUrl) {
      console.log(`[图片请求 ${requestId}] 失败 - 缺少url参数`);
      return res.status(400).json({ error: "缺少url参数" });
    }

    // 自动补全协议
    if (imageUrl.startsWith("//")) {
      imageUrl = "https:" + imageUrl;
    } else if (!imageUrl.startsWith("http://") && !imageUrl.startsWith("https://")) {
      imageUrl = "https://" + imageUrl;
    }

    // 获取源特定的 Headers
    let requestHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0'
    };

    const sourceName = req.query.source;
    if (sourceName) {
        const source = runtime.getSource(sourceName);
        if (source) {
            // 尝试获取源的 headers
            // 1. 尝试 headers getter
            if (source.headers) {
                try {
                    // source.headers 可能是 getter，直接访问即可
                    const sourceHeaders = source.headers;
                    if (sourceHeaders) {
                        // 过滤掉 content-length 和 host 等可能冲突的 headers
                        const cleanHeaders = { ...sourceHeaders };
                        delete cleanHeaders['content-length'];
                        delete cleanHeaders['host'];
                        delete cleanHeaders['connection'];
                        
                        Object.assign(requestHeaders, cleanHeaders);
                    }
                } catch (e) {
                    console.warn(`Failed to get headers from source ${sourceName}:`, e.message);
                }
            }
            
            // 2. 如果源有 onImageLoad 方法，也可以尝试调用它获取配置
            // 注意：这需要 comicId 和 epId
            /*
            const comicId = req.query.comicId;
            const epId = req.query.epId;
            if (source.comic && source.comic.onImageLoad) {
                try {
                    const config = await Promise.resolve(source.comic.onImageLoad(imageUrl, comicId, epId));
                    if (config && config.headers) {
                        Object.assign(requestHeaders, config.headers);
                    }
                } catch (e) {
                    console.warn(`Failed to get image load config from source ${sourceName}:`, e.message);
                }
            }
            */
        }
    }

    const targetWidth = parseInt(req.query.width) || 600
    const quality = parseInt(req.query.quality) || 50

    console.log(`[图片请求 ${requestId}] 下载图片 - 目标宽度: ${targetWidth}, 质量: ${quality}`)

    const downloadStart = Date.now()
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      headers: requestHeaders,
      timeout: 30000,
      maxContentLength: 50 * 1024 * 1024,
      maxRedirects: 3
    })
    const downloadTime = Date.now() - downloadStart;

    console.log(
      `[图片请求 ${requestId}] 下载完成 - 耗时: ${downloadTime}ms, 大小: ${(response.data.byteLength / 1024).toFixed(2)}KB`,
    );

    if (response.status !== 200) {
      console.log(
        `[图片请求 ${requestId}] 失败 - HTTP状态码: ${response.status}`,
      );
      return res
        .status(500)
        .json({ error: `图片下载失败: ${response.status}` });
    }

    const contentLength = response.data.byteLength;
    if (contentLength > 50 * 1024 * 1024) {
      console.log(
        `[图片请求 ${requestId}] 失败 - 图片过大: ${(contentLength / 1024 / 1024).toFixed(2)}MB`,
      );
      return res.status(413).json({ error: "图片过大，最大支持 50MB" });
    }

    const contentType = response.headers["content-type"] || "image/jpeg";
    console.log(`[图片请求 ${requestId}] 原始 Content-Type: ${contentType}`);

    // 如果是 GIF，直接返回（保留动画）
    // WebP 强制转换为 JPEG/PNG
    if (
      contentType.includes("gif") ||
      (!contentType.includes("webp") && targetWidth === 0 && quality === 100)
    ) {
      console.log(`[图片请求 ${requestId}] 跳过处理，直接返回原图`);
      res.set({
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
      });
      const totalTime = Date.now() - startTime;
      console.log(
        `[图片请求 ${requestId}] 成功完成(未处理) - 总耗时: ${totalTime}ms`,
      );
      return res.send(response.data);
    }

    console.log(`[图片请求 ${requestId}] 开始处理图片...`);
    const processStart = Date.now();

    let sharpInstance = sharp(response.data, {
      limitInputPixels: 268402689,
    });

    let imageBuffer;
    if (contentType.includes("png")) {
      imageBuffer = await sharpInstance
        .resize({
          width: targetWidth > 0 ? targetWidth : null,
          height: null,
          fit: sharp.fit.inside,
          withoutEnlargement: true,
        })
        .png({
          quality: quality,
        })
        .toBuffer();
      res.set({
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      });
    } else {
      imageBuffer = await sharpInstance
        .resize({
          width: targetWidth > 0 ? targetWidth : null,
          height: null,
          fit: sharp.fit.inside,
          withoutEnlargement: true,
        })
        .jpeg({
          quality: quality,
          progressive: true,
          mozjpeg: true,
        })
        .toBuffer();
      res.set({
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      });
    }

    const processTime = Date.now() - processStart;

    sharpInstance = null;

    console.log(
      `[图片请求 ${requestId}] 图片处理完成 - 耗时: ${processTime}ms, 输出大小: ${(imageBuffer.length / 1024).toFixed(2)}KB`,
    );

    res.send(imageBuffer);

    const totalTime = Date.now() - startTime;
    console.log(`[图片请求 ${requestId}] 成功完成 - 总耗时: ${totalTime}ms`);
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[图片请求 ${requestId}] 失败 - 耗时: ${totalTime}ms`);
    console.error(`[图片请求 ${requestId}] 错误名称: ${error.name}`);
    console.error(`[图片请求 ${requestId}] 错误信息: ${error.message}`);
    console.error(`[图片请求 ${requestId}] 错误代码: ${error.code}`);
    console.error(`[图片请求 ${requestId}] 错误堆栈: ${error.stack}`);

    if (error.response) {
      console.error(
        `[图片请求 ${requestId}] HTTP响应状态: ${error.response.status}`,
      );
      return res.status(error.response.status).json({
        error: `图片下载失败: ${error.response.status}`,
      });
    }

    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      console.error(`[图片请求 ${requestId}] 请求超时`);
      return res.status(504).json({ error: "请求超时" });
    }

    res.status(500).json({ error: `图片处理失败: ${error.message}` });
  } finally {
    activeImageRequests--;
    console.log(
      `[图片请求 ${requestId}] 结束 - 活跃请求: ${activeImageRequests}, 队列长度: ${imageRequestQueue.length}`,
    );
    processNextImageRequest();
  }
}

// 确保 sources 目录存在
if (!fs.existsSync(SOURCES_DIR)) {
  fs.mkdirSync(SOURCES_DIR, { recursive: true });
}

// 加载所有漫画源
async function loadAllSources() {
  const files = fs.readdirSync(SOURCES_DIR);
  const loadedSources = [];

  for (const file of files) {
    if (file.endsWith(".js")) {
      try {
        const sourcePath = path.join(SOURCES_DIR, file);
        const source = runtime.loadSource(sourcePath);

        // 设置默认设置值
        setDefaultSettings(source);

        // 调用 init 方法（如果存在）
        if (typeof source.init === "function") {
          try {
            // 处理可能返回 Promise 的 init 方法
            await Promise.resolve(source.init());
          } catch (initError) {
            console.warn(`Init error for ${source.name}:`, initError.message);
          }
        }

        loadedSources.push({
          name: source.name,
          key: source.key,
          file: file,
        });
        console.log(`Loaded source: ${source.name} (${file})`);
      } catch (error) {
        console.error(`Failed to load source ${file}:`, error.message);
      }
    }
  }

  return loadedSources;
}

// 设置默认设置值
function setDefaultSettings(source) {
  // 获取类的静态属性作为默认设置
  const classDefaults = source.constructor;

  // 常见的默认设置
  const commonDefaults = {
    base_url: classDefaults.defaultApiUrl,
    region: classDefaults.defaultCopyRegion,
    image_quality: classDefaults.defaultImageQuality,
  };

  for (const [key, value] of Object.entries(commonDefaults)) {
    if (value && !source.loadSetting(key)) {
      source.saveSetting(key, value);
    }
  }
}

// 初始化加载（异步）
let loadedSources = [];
loadAllSources()
  .then((sources) => {
    loadedSources = sources;
    console.log(
      `\nServer ready! Loaded ${sources.length} source(s): ${sources.map((s) => s.name).join(", ") || "None"}`,
    );

    // 定时刷新源，以更新动态配置（如CopyManga的base_url）
    setInterval(async () => {
      console.log("Running periodic source refresh...");
      for (const sourceInfo of loadedSources) {
        const source = runtime.getSource(sourceInfo.name);
        if (source && typeof source.init === "function") {
          try {
            await Promise.resolve(source.init());
            console.log(`Refreshed source: ${source.name}`);
          } catch (e) {
            console.warn(`Failed to refresh source ${source.name}:`, e.message);
          }
        }
      }
    }, 60 * 1000);
  })
  .catch((err) => {
    console.error("Failed to load sources:", err);
  });

// 中间件
app.use(express.json());

// 设置请求超时
app.use((req, res, next) => {
  res.setTimeout(60000, () => {
    console.log(`请求超时: ${req.method} ${req.url}`);
    res.status(504).json({ error: "请求超时" });
  });
  next();
});

// CORS 支持
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization",
  );
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

// 健康检查 - 返回 HTML 页面并注入 Speed Insights
app.get("/", (req, res) => {
  const baseUrl = getBaseUrl(req);
  const sources = loadedSources.map((s) => s.name).join(", ") || "None";
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Venera Source Converter</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #333;
    }
    .container {
      background: white;
      border-radius: 10px;
      padding: 40px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    }
    h1 {
      color: #667eea;
      margin-bottom: 10px;
    }
    .status {
      display: inline-block;
      background: #10b981;
      color: white;
      padding: 5px 15px;
      border-radius: 20px;
      font-weight: bold;
      margin-bottom: 20px;
    }
    .info {
      background: #f3f4f6;
      padding: 15px;
      border-radius: 5px;
      margin: 15px 0;
    }
    .sources {
      color: #667eea;
      font-weight: bold;
    }
    .api-docs {
      margin-top: 30px;
    }
    .endpoint {
      background: #f9fafb;
      border-left: 4px solid #667eea;
      padding: 10px;
      margin: 10px 0;
      font-family: 'Courier New', monospace;
    }
    a {
      color: #667eea;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🚀 Venera Source Converter</h1>
    <div class="status">● Running</div>
    
    <div class="info">
      <p><strong>Message:</strong> Venera Source Converter is running</p>
      <p><strong>Loaded Sources:</strong> <span class="sources">${sources}</span></p>
      <p><strong>Base URL:</strong> ${baseUrl}</p>
    </div>
    
    <div class="api-docs">
      <h2>📚 API Endpoints</h2>
      <div class="endpoint">GET /config - Get all source configurations</div>
      <div class="endpoint">GET /search/:text/:page?source=&lt;source&gt; - Search comics</div>
      <div class="endpoint">GET /comic/:id?source=&lt;source&gt; - Get comic details</div>
      <div class="endpoint">GET /photo/:id/chapter/:chapter?source=&lt;source&gt; - Get chapter images</div>
      <div class="endpoint">GET /proxy?url=&lt;url&gt; - Proxy images</div>
      <div class="endpoint">POST /reload - Reload all sources</div>
    </div>
    
    <p style="margin-top: 30px; text-align: center; color: #6b7280;">
      <a href="https://github.com/venera-app" target="_blank">Powered by Venera</a>
    </p>
  </div>
  
  <script>
    window.si = window.si || function () { (window.siq = window.siq || []).push(arguments); };
  </script>
  <script defer src="/_vercel/speed-insights/script.js"></script>
</body>
</html>`;
  
  res.send(html);
});

// API 端点 - 返回 JSON 格式的状态信息
app.get("/api/status", (req, res) => {
  res.json({
    status: "ok",
    sources: loadedSources.map((s) => s.name),
    message: "Venera Source Converter is running",
  });
});

// 重新加载漫画源
app.post("/reload", async (req, res) => {
  try {
    loadedSources = await loadAllSources();
    res.json({
      status: "ok",
      sources: loadedSources.map((s) => s.name),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Config 端点 - 返回所有漫画源配置
app.get("/config", (req, res) => {
  const config = {};

  for (const sourceInfo of loadedSources) {
    const source = runtime.getSource(sourceInfo.name);
    if (source) {
      // 构建配置
      const apiUrl = getBaseUrl(req);

      const sourceConfig = {
        name: source.name,
        apiUrl: apiUrl,
        detailPath: `/comic/<id>?source=${encodeURIComponent(source.name)}`,
        photoPath: `/photo/<id>/chapter/<chapter>?source=${encodeURIComponent(source.name)}`,
        searchPath: `/search/<text>/<page>?source=${encodeURIComponent(source.name)}`,
        type: source.name,
      };
      config[source.name] = sourceConfig;
    }
  }

  res.json(config);
});

// 漫画详情端点
app.get("/comic/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sourceName = req.query.source;

    if (!sourceName) {
      return res.status(400).json({ error: "Missing source parameter" });
    }

    const source = runtime.getSource(sourceName);
    if (!source) {
      return res.status(404).json({ error: `Source not found: ${sourceName}` });
    }

    if (!source.comic || !source.comic.loadInfo) {
      return res
        .status(501)
        .json({ error: "Source does not support comic details" });
    }

    const comicDetails = await source.comic.loadInfo(id);

    // 转换为项目格式
    // 处理 tags - 可能是 Map、数组或对象
    let tags = [];
    if (comicDetails.tags) {
      if (comicDetails.tags instanceof Map) {
        tags = Array.from(comicDetails.tags.values()).flat();
      } else if (Array.isArray(comicDetails.tags)) {
        tags = comicDetails.tags;
      } else if (typeof comicDetails.tags === "object") {
        tags = Object.values(comicDetails.tags).flat();
      }
    }

    // Calculate total chapters
    let totalChapters = 0;
    if (comicDetails.chapters) {
      if (comicDetails.chapters instanceof Map) {
        for (const val of comicDetails.chapters.values()) {
          if (val instanceof Map) {
            totalChapters += val.size;
          } else {
            totalChapters++;
          }
        }
      } else if (typeof comicDetails.chapters === "object") {
        totalChapters = Object.keys(comicDetails.chapters).length;
      }
    }

    // Handle page count and chapter count logic:
    // - If it's a oneshot/single chapter (totalChapters <= 1): return page_count (if available) and total_chapters = 1
    // - If it's a multi-chapter comic (totalChapters > 1): return total_chapters and page_count = 0
    let finalPageCount = 0;
    let finalTotalChapters = totalChapters > 0 ? totalChapters : 1;

    if (finalTotalChapters <= 1) {
      // It's a single chapter, try to find the page count
      if (comicDetails.thumbnails && comicDetails.thumbnails.length > 0) {
        finalPageCount = comicDetails.thumbnails.length;
      } else if (
        comicDetails.maxPage !== null &&
        comicDetails.maxPage !== undefined
      ) {
        finalPageCount = comicDetails.maxPage;
      }
      finalTotalChapters = 1; // Ensure it's exactly 1
    } else {
      // It's a multi-chapter comic, do not return page count
      finalPageCount = 0;
    }

    // 构建基础 URL
    const baseUrl = getBaseUrl(req);

    const response = {
      item_id: comicDetails.id || id, // 优先使用源返回的 ID，如果没有则使用请求参数中的 ID
      name: comicDetails.title,
      page_count: finalPageCount,
      views: 0,
      rate: comicDetails.stars || 0,
      cover: `${baseUrl}/proxy?url=${comicDetails.cover}&width=200`,
      tags: tags,
      total_chapters: finalTotalChapters,
    };

    res.json(response);
  } catch (error) {
    console.error("Error loading comic info:", error);
    res.status(500).json({ error: error.message });
  }
});

// 图片列表端点
app.get("/photo/:id/chapter/:chapter", async (req, res) => {
  try {
    const { id, chapter } = req.params;
    const sourceName = req.query.source;
    const width = req.query.width || 600;
    const quality = req.query.quality || 50;

    if (!sourceName) {
      return res.status(400).json({ error: "Missing source parameter" });
    }

    const source = runtime.getSource(sourceName);
    if (!source) {
      return res.status(404).json({ error: `Source not found: ${sourceName}` });
    }

    if (!source.comic || !source.comic.loadEp) {
      return res
        .status(501)
        .json({ error: "Source does not support loading episodes" });
    }

    // 处理章节 ID - 某些源（如 MangaDex）使用 UUID 而不是章节号
    let epId = chapter;

    // 如果 chapter 是纯数字，可能需要查找对应的章节 ID
    if (/^\d+$/.test(chapter)) {
      // 尝试获取漫画详情来查找章节 ID
      if (source.comic.loadInfo) {
        try {
          const comicDetails = await source.comic.loadInfo(id);

          if (comicDetails.chapters) {
            // 遍历章节 Map 查找对应序号的章节
            let chapterIndex = parseInt(chapter) - 1; // 转换为 0-based 索引
            let currentIndex = 0;
            let foundId = null;

            // Handle Map structure (Volume -> Chapter Map OR Chapter Id -> Title)
            if (comicDetails.chapters instanceof Map) {
              for (const [key, value] of comicDetails.chapters) {
                if (value instanceof Map) {
                  // Nested Map: key is volume name, value is chapters map
                  for (const [chId, chTitle] of value) {
                    if (currentIndex === chapterIndex) {
                      foundId = chId;
                      break;
                    }
                    currentIndex++;
                  }
                } else {
                  // Flat Map: key is chapter id, value is title
                  if (currentIndex === chapterIndex) {
                    foundId = key;
                    break;
                  }
                  currentIndex++;
                }
                if (foundId) break;
              }
            }

            if (foundId) {
              epId = foundId;
            }
          }
        } catch (e) {
          console.warn("Failed to resolve chapter ID:", e.message);
        }
      }
    }

    const epData = await source.comic.loadEp(id, epId);

    // 构建基础 URL
    const baseUrl = getBaseUrl(req);

    // 确定章节标题
    let chapterTitle = `Comic ${id}`;
    
    // 如果之前成功获取了漫画详情
    if (source.comic.loadInfo) {
        try {
            // 尝试从缓存或重新获取详情来拿到标题
            // 这里为了性能，如果有必要可以缓存 comicDetails
            // 简单起见，我们尝试从 comicDetails 中查找章节名
            // 注意：这里我们无法直接访问上面的 comicDetails 变量，因为它在 if 块里
            // 所以我们需要一个更健壮的方式来获取标题
            
            // 重新获取一下详情（虽然有点浪费，但为了准确性）
            // 实际上，为了性能，我们最好只在必要时获取
            // 更好的做法是：如果前端能传标题最好，但不能。
            
            // 让我们尝试解析章节名
            // 如果是纯数字章节号
            if (/^\d+$/.test(chapter)) {
                 chapterTitle = `Ch ${chapter}`;
            } else {
                 chapterTitle = chapter; // 使用章节ID作为标题
            }
            
            // 尝试获取漫画详情以获得更准确的标题（如果是单篇）
            try {
                const comicDetails = await source.comic.loadInfo(id);
                
                // 计算总章节数判断是否为单篇
                let totalChapters = 0;
                let foundChapterTitle = null;
                
                if (comicDetails.chapters) {
                    if (comicDetails.chapters instanceof Map) {
                        for (const [key, value] of comicDetails.chapters) {
                            if (value instanceof Map) {
                                totalChapters += value.size;
                                // 查找章节标题
                                if (value.has(epId)) foundChapterTitle = value.get(epId);
                            } else {
                                totalChapters++;
                                // 扁平 Map，key 是 id
                                if (key === epId) foundChapterTitle = value;
                            }
                        }
                    } else if (typeof comicDetails.chapters === 'object') {
                        totalChapters = Object.keys(comicDetails.chapters).length;
                        if (comicDetails.chapters[epId]) foundChapterTitle = comicDetails.chapters[epId];
                    }
                }
                
                // 如果是单篇（章节数 <= 1），直接使用漫画标题
                if (totalChapters <= 1) {
                    chapterTitle = comicDetails.title;
                } else if (foundChapterTitle) {
                    // 如果是多章节且找到了章节标题，使用章节标题
                    chapterTitle = foundChapterTitle;
                }
            } catch (e) {
                // 获取详情失败，降级使用默认标题
                console.warn('Failed to load comic details for title:', e.message);
            }
        } catch (e) {
            // 忽略错误
        }
    }

    // 转换为项目格式，添加代理 URL
    const response = {
      title: chapterTitle,
      images: epData.images.map((url, index) => ({
        url: `${baseUrl}/proxy?url=${url}&width=${width}&quality=${quality}`,
      })),
    };

    res.json(response);
  } catch (error) {
    console.error("Error loading episode:", error);
    res.status(500).json({ error: error.message });
  }
});

// 搜索端点
app.get("/search/:text/:page", async (req, res) => {
  try {
    const { text, page } = req.params;
    const sourceName = req.query.source;

    if (!sourceName) {
      return res.status(400).json({ error: "Missing source parameter" });
    }

    const source = runtime.getSource(sourceName);
    if (!source) {
      return res.status(404).json({ error: `Source not found: ${sourceName}` });
    }

    if (!source.search || !source.search.load) {
      return res.status(501).json({ error: "Source does not support search" });
    }

    // 调用搜索功能
    // 获取默认选项（使用第一个选项作为默认值）
    let options = [];
    if (source.search.optionList) {
      options = source.search.optionList.map((opt) => {
        if (opt.default) return opt.default;
        // 从第一个选项中提取值（格式: "value-Label"）
        if (opt.options && opt.options.length > 0) {
          const firstOption = opt.options[0];
          if (typeof firstOption === "string" && firstOption.includes("-")) {
            return firstOption.split("-")[0];
          }
          return firstOption;
        }
        return null;
      });
    }
    const searchResult = await source.search.load(
      decodeURIComponent(text),
      options,
      parseInt(page),
    );

    // 构建基础 URL
    const baseUrl = getBaseUrl(req);

    // 转换为项目格式
    const response = {
      page: parseInt(page),
      has_more: page < searchResult.maxPage,
      results: searchResult.comics.map((comic) => ({
        comic_id: comic.id,
        title: comic.title,
        cover_url: `${baseUrl}/proxy?url=${comic.cover}&width=100`,
        pages: 0,
      })),
    };

    res.json(response);
  } catch (error) {
    console.error("Error searching:", error);
    res.status(500).json({ error: error.message });
  }
});

// 图片代理端点
app.get("/proxy", (req, res) => {
  if (imageRequestQueue.length >= MAX_QUEUE_SIZE) {
    return res.status(429).json({ error: "请求过多，请稍后再试" });
  }

  if (activeImageRequests < MAX_CONCURRENT_IMAGE_REQUESTS) {
    processImageRequest(req, res);
  } else {
    imageRequestQueue.push({ req, res });
  }
});

// 启动服务器
// 获取命令行参数中的端口号
const args = process.argv.slice(2);
let portFromArgs = null;
for (const arg of args) {
  const parsed = parseInt(arg, 10);
  if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
    portFromArgs = parsed;
    break;
  }
}

const PORT = portFromArgs || process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Venera Source Converter running on port ${PORT}`);
  console.log(`Please place your .js source files in: ${SOURCES_DIR}`);
  console.log("Loading sources...");
});
