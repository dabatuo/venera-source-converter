const axios = require('axios');

/**
 * Cookie 存储
 */
const cookieStore = new Map();

/**
 * Cookie 类
 */
class Cookie {
    constructor({ name, value, domain }) {
        this.name = name;
        this.value = value;
        this.domain = domain;
    }
}

/**
 * Network API - 网络请求工具
 * 实现 Venera 的所有 Network 功能
 */
class Network {
    /**
     * 发送请求并返回二进制数据
     * @param {string} method - HTTP 方法
     * @param {string} url - 请求 URL
     * @param {object} headers - 请求头
     * @param {ArrayBuffer} data - 请求体数据
     * @returns {Promise<{status: number, headers: object, body: ArrayBuffer}>}
     */
    static async fetchBytes(method, url, headers = {}, data = null) {
        let attempts = 0;
        const maxAttempts = 3;
        
        while (attempts < maxAttempts) {
            attempts++;
            try {
                let bodyData = data;
                if (
                    bodyData &&
                    typeof bodyData === 'object' &&
                    !Buffer.isBuffer(bodyData) &&
                    !(bodyData instanceof ArrayBuffer) &&
                    !ArrayBuffer.isView(bodyData) &&
                    !Array.isArray(bodyData)
                ) {
                    bodyData = JSON.stringify(bodyData);
                }
                const response = await axios({
                    method: method.toLowerCase(),
                    url,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0',
                        'Connection': 'close', // 禁用 keep-alive 防止 socket hang up
                        ...headers
                    },
                    httpAgent: new (require('http').Agent)({ keepAlive: false }),
                    httpsAgent: new (require('https').Agent)({ keepAlive: false }),
                    data: bodyData != null ? Buffer.from(bodyData) : undefined,
                    responseType: 'arraybuffer',
                    timeout: 30000,
                    validateStatus: () => true
                });

                return {
                    status: response.status,
                    headers: response.headers,
                    body: response.data
                };
            } catch (error) {
                // 如果是 socket hang up 或其他网络错误，且未达到最大重试次数，则重试
                if (attempts < maxAttempts && (error.code === 'ECONNRESET' || error.message.includes('socket hang up'))) {
                    console.warn(`Network error (${error.message}) for ${url}. Retrying attempt ${attempts + 1}...`);
                    await new Promise(resolve => setTimeout(resolve, 1000 * attempts)); // 指数退避
                    continue;
                }
                throw new Error(`Network error: ${error.message}`);
            }
        }
    }

    /**
     * 发送请求并返回字符串
     * @param {string} method - HTTP 方法
     * @param {string} url - 请求 URL
     * @param {object} headers - 请求头
     * @param {ArrayBuffer} data - 请求体数据
     * @returns {Promise<{status: number, headers: object, body: string}>}
     */
    static async sendRequest(method, url, headers = {}, data = null) {
        const result = await this.fetchBytes(method, url, headers, data);
        return {
            status: result.status,
            headers: result.headers,
            body: Buffer.from(result.body).toString('utf-8')
        };
    }

    /**
     * 发送 GET 请求
     * @param {string} url
     * @param {object} headers
     * @returns {Promise<{status: number, headers: object, body: string}>}
     */
    static async get(url, headers = {}) {
        return this.sendRequest('GET', url, headers);
    }

    /**
     * 发送 POST 请求
     * @param {string} url
     * @param {object} headers
     * @param {ArrayBuffer|string} data
     * @returns {Promise<{status: number, headers: object, body: string}>}
     */
    static async post(url, headers = {}, data = null) {
        let bodyData = data;
        if (typeof data === 'string') {
            bodyData = Buffer.from(data);
        }
        return this.sendRequest('POST', url, headers, bodyData);
    }

    /**
     * 发送 PUT 请求
     * @param {string} url
     * @param {object} headers
     * @param {ArrayBuffer} data
     * @returns {Promise<{status: number, headers: object, body: string}>}
     */
    static async put(url, headers = {}, data = null) {
        return this.sendRequest('PUT', url, headers, data);
    }

    /**
     * 发送 DELETE 请求
     * @param {string} url
     * @param {object} headers
     * @returns {Promise<{status: number, headers: object, body: string}>}
     */
    static async delete(url, headers = {}) {
        return this.sendRequest('DELETE', url, headers);
    }

    /**
     * 发送 PATCH 请求
     * @param {string} url
     * @param {object} headers
     * @param {ArrayBuffer} data
     * @returns {Promise<{status: number, headers: object, body: string}>}
     */
    static async patch(url, headers = {}, data = null) {
        return this.sendRequest('PATCH', url, headers, data);
    }

    /**
     * 设置 Cookies
     * @param {string} url
     * @param {Cookie[]} cookies
     */
    static setCookies(url, cookies) {
        const domain = new URL(url).hostname;
        if (!cookieStore.has(domain)) {
            cookieStore.set(domain, []);
        }
        const domainCookies = cookieStore.get(domain);
        for (const cookie of cookies) {
            const existingIndex = domainCookies.findIndex(c => c.name === cookie.name);
            if (existingIndex >= 0) {
                domainCookies[existingIndex] = cookie;
            } else {
                domainCookies.push(cookie);
            }
        }
    }

    /**
     * 获取 Cookies
     * @param {string} url
     * @returns {Cookie[]}
     */
    static getCookies(url) {
        const domain = new URL(url).hostname;
        return cookieStore.get(domain) || [];
    }

    /**
     * 删除 Cookies
     * @param {string} url
     */
    static deleteCookies(url) {
        const domain = new URL(url).hostname;
        cookieStore.delete(domain);
    }
}

/**
 * fetch API - 浏览器风格的 fetch
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Response>}
 */
async function fetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = options.headers || {};
    const body = options.body;

    try {
        const response = await axios({
            method: method.toLowerCase(),
            url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0',
                ...headers
            },
            data: body,
            responseType: 'arraybuffer',
            timeout: 30000,
            validateStatus: () => true
        });

        // 添加调试日志
        if (response.status < 200 || response.status >= 300) {
            console.warn(`HTTP ${response.status} for ${url}`);
            const responseText = Buffer.from(response.data).toString('utf-8').substring(0, 200);
            console.warn('Response:', responseText);
        }

        return {
            status: response.status,
            ok: response.status >= 200 && response.status < 300,
            headers: response.headers,
            arrayBuffer: async () => response.data,
            text: async () => Buffer.from(response.data).toString('utf-8'),
            json: async () => JSON.parse(Buffer.from(response.data).toString('utf-8'))
        };
    } catch (error) {
        console.warn('Fetch error for ' + url + ':', error.message);
        return {
            status: 0,
            ok: false,
            headers: {},
            arrayBuffer: async () => new ArrayBuffer(0),
            text: async () => '',
            json: async () => ({})
        };
    }
}

module.exports = { Network, Cookie, fetch, cookieStore };
