const { Convert } = require('./Convert');
const { Network, Cookie, fetch } = require('./Network');
const { HtmlDocument, HtmlElement, HtmlNode } = require('./HtmlDocument');
const { UI } = require('./UI');
const { createUuid, randomInt, randomDouble, DataStorage } = require('./Utils');
const { Comic, ComicDetails, Comment } = require('./ComicTypes');
const fs = require('fs');
const os = require('os');
const path = require('path');

class VeneraRuntime {
    constructor() {
        this.sources = new Map();
    }

    // 从源代码中提取简单字段（字符串、数字、布尔值）
    extractSimpleFields(code) {
        const fields = {};
        const lines = code.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            // 匹配简单字段: name = "value" 或 name = 123 或 name = true/false
            const match = trimmed.match(/^(\w+)\s*=\s*(.+?);?$/);
            if (match) {
                const fieldName = match[1];
                let fieldValue = match[2].trim();

                // 跳过包含函数定义的行
                if (fieldValue.includes('=>') || fieldValue.includes('function')) {
                    continue;
                }

                // 跳过对象/数组定义的开始行
                if (fieldValue === '{' || fieldValue === '[' ||
                    fieldValue.endsWith('{') || fieldValue.endsWith('[')) {
                    continue;
                }

                try {
                    // 字符串
                    if ((fieldValue.startsWith('"') && fieldValue.endsWith('"')) ||
                        (fieldValue.startsWith("'") && fieldValue.endsWith("'"))) {
                        fields[fieldName] = fieldValue.slice(1, -1);
                    }
                    // 布尔值
                    else if (fieldValue === 'true') {
                        fields[fieldName] = true;
                    }
                    else if (fieldValue === 'false') {
                        fields[fieldName] = false;
                    }
                    // 数字
                    else if (!isNaN(fieldValue) && fieldValue !== '' && !fieldValue.includes(' ')) {
                        fields[fieldName] = Number(fieldValue);
                    }
                } catch (e) {
                    // 忽略解析错误
                }
            }
        }

        return fields;
    }

    // 加载漫画源
    loadSource(filePath) {
        const fullPath = path.resolve(filePath);
        if (!fs.existsSync(fullPath)) {
            throw new Error(`Source file not found: ${fullPath}`);
        }

        const code = fs.readFileSync(fullPath, 'utf-8');

        // 提取简单字段
        const simpleFields = this.extractSimpleFields(code);

        // 获取类名
        const classNameMatch = code.match(/class\s+(\w+)\s+extends/);
        if (!classNameMatch) {
            throw new Error('Could not find class definition in source file');
        }
        const sourceClassName = classNameMatch[1];

        // 创建包装模块代码
        const runtimeDir = __dirname;

        // 构建模块代码
        const header = `
const { Convert } = require(${JSON.stringify(path.join(runtimeDir, 'Convert'))});
const { Network, Cookie, fetch } = require(${JSON.stringify(path.join(runtimeDir, 'Network'))});
const { HtmlDocument, HtmlElement, HtmlNode } = require(${JSON.stringify(path.join(runtimeDir, 'HtmlDocument'))});
const { UI } = require(${JSON.stringify(path.join(runtimeDir, 'UI'))});
const { createUuid, randomInt, randomDouble } = require(${JSON.stringify(path.join(runtimeDir, 'Utils'))});
const { Comic, ComicDetails, Comment } = require(${JSON.stringify(path.join(runtimeDir, 'ComicTypes'))});

// APP 全局对象模拟
const APP = {
    locale: 'zh_CN',
    version: '2.1.0'
};

// 模拟 sendMessage 全局函数
global.sendMessage = (msg) => {
    // 简单模拟，返回 null 或默认值
    return null;
};

class ComicSource {
    constructor() {
        const defaults = {
            name: '',
            key: '',
            version: '1.0.0',
            minAppVersion: '1.0.0',
            url: '',
            baseUrl: '',
            account: null,
            explore: [],
            category: null,
            categoryComics: null,
            search: null,
            favorites: null,
            comic: null,
            translation: {},
        };
        for (const [key, value] of Object.entries(defaults)) {
            // 子类可能通过只读 getter 暴露同名属性（如 baseUrl），此时跳过默认值赋值
            if (!(key in this)) {
                this[key] = value;
            }
        }
    }

    // 数据持久化方法
    loadData(key) {
        if (!this._dataStorage) {
            const { DataStorage } = require(${JSON.stringify(path.join(runtimeDir, 'Utils'))});
            this._dataStorage = new DataStorage(this.key || this.name);
        }
        return this._dataStorage.loadData(key);
    }

    saveData(key, value) {
        if (!this._dataStorage) {
            const { DataStorage } = require(${JSON.stringify(path.join(runtimeDir, 'Utils'))});
            this._dataStorage = new DataStorage(this.key || this.name);
        }
        return this._dataStorage.saveData(key, value);
    }

    loadSetting(key) {
        if (!this._dataStorage) {
            const { DataStorage } = require(${JSON.stringify(path.join(runtimeDir, 'Utils'))});
            this._dataStorage = new DataStorage(this.key || this.name);
        }
        return this._dataStorage.loadSetting(key);
    }

    saveSetting(key, value) {
        if (!this._dataStorage) {
            const { DataStorage } = require(${JSON.stringify(path.join(runtimeDir, 'Utils'))});
            this._dataStorage = new DataStorage(this.key || this.name);
        }
        return this._dataStorage.saveSetting(key, value);
    }

    deleteData(key) {
        if (!this._dataStorage) {
            const { DataStorage } = require(${JSON.stringify(path.join(runtimeDir, 'Utils'))});
            this._dataStorage = new DataStorage(this.key || this.name);
        }
        return this._dataStorage.deleteData(key);
    }
}

`;

        const footer = `

module.exports = ${sourceClassName};
`;

        const moduleCode = header + code + footer;

        // 写入临时文件（Vercel 等只读部署环境使用系统临时目录）
        const tempFile = path.join(os.tmpdir(), `venera_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.js`);
        fs.writeFileSync(tempFile, moduleCode);

        try {
            // 加载模块
            const SourceClass = require(tempFile);

            if (!SourceClass) {
                throw new Error('Could not find comic source class in file');
            }

            // 创建实例
            const source = new SourceClass();

            // 合并简单字段（如果实例中没有的话）
            for (const [key, value] of Object.entries(simpleFields)) {
                if (!source[key] || source[key] === '' || source[key] === null) {
                    try {
                        source[key] = value;
                    } catch (e) {
                        // 跳过只读 getter 字段（如 baseUrl）
                    }
                }
            }

            // 存储漫画源
            const sourceKey = source.name || source.key || sourceClassName;
            this.sources.set(sourceKey, source);

            return source;
        } finally {
            // 清理临时文件
            try {
                fs.unlinkSync(tempFile);
            } catch (e) {
                // 忽略删除错误
            }
        }
    }

    // 获取已加载的漫画源
    getSource(name) {
        return this.sources.get(name);
    }

    // 获取所有已加载的漫画源
    getAllSources() {
        return Array.from(this.sources.values());
    }
}

module.exports = VeneraRuntime;
