const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

// ==================== متغيرات البيئة ====================
const PORT = process.env.PORT || 3000;
const DATABASE_SECRETS = "KXPNxnGZDA1BGnzs4kZIA45o6Vr9P5nJ3Z01X4bt";
const DATABASE_URL = "https://hackerdz-b1bdf.firebaseio.com";
const SERVER_2_URL = process.env.SERVER_2_URL || 'http://localhost:3001';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

// ==================== إعدادات النظام ====================
const SYSTEM_CONFIG = {
    MAX_MANGA_PER_GROUP: 50,
    MAX_PAGES: 67,
    DELAY_BETWEEN_PAGES: 5000,
    DELAY_BETWEEN_MANGA: 1000,
    USE_IMGBB: false,
    GROUP_PREFIX: 'HomeManga',
    CHAPTER_GROUP_PREFIX: 'ImgChapter'
};

const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// ==================== دوال Firebase ====================
async function writeToFirebase(path, data) {
    if (!FIXED_DB_URL || !DATABASE_SECRETS) {
        console.error('❌ خطأ: متغيرات Firebase غير موجودة.');
        return;
    }
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try {
        await axios.put(url, data);
    } catch (error) {
        console.error(`❌ فشل الكتابة إلى Firebase في ${path}:`, error.message);
        throw error;
    }
}

async function readFromFirebase(path) {
    if (!FIXED_DB_URL || !DATABASE_SECRETS) {
        console.error('❌ خطأ: متغيرات Firebase غير موجودة.');
        return null;
    }
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 404) {
            return null;
        }
        console.error(`❌ فشل القراءة من Firebase في ${path}:`, error.message);
        throw error;
    }
}

// ==================== نظام المجموعات الذكي ====================
class GroupManager {
    constructor() {
        this.groupCounter = 1;
        this.currentGroupCount = 0;
        this.totalMangaSaved = 0;
    }
    
    async initialize() {
        const stats = await readFromFirebase('System/stats');
        if (stats) {
            this.groupCounter = stats.currentGroup || 1;
            this.currentGroupCount = stats.currentGroupCount || 0;
            this.totalMangaSaved = stats.totalManga || 0;
            console.log(`📊 تم تحميل: المجموعة ${this.groupCounter}, العدد ${this.currentGroupCount}`);
        } else {
            await writeToFirebase('System/stats', {
                currentGroup: 1,
                currentGroupCount: 0,
                totalManga: 0,
                created: Date.now()
            });
        }
    }
    
    async getCurrentGroup() {
        if (this.currentGroupCount >= SYSTEM_CONFIG.MAX_MANGA_PER_GROUP) {
            this.groupCounter++;
            this.currentGroupCount = 0;
            console.log(`🔄 الانتقال إلى المجموعة ${this.groupCounter}`);
        }
        return `${SYSTEM_CONFIG.GROUP_PREFIX}_${this.groupCounter}`;
    }
    
    async incrementGroupCount() {
        this.currentGroupCount++;
        this.totalMangaSaved++;
        
        if (this.currentGroupCount > SYSTEM_CONFIG.MAX_MANGA_PER_GROUP) {
            this.groupCounter++;
            this.currentGroupCount = 1;
            console.log(`🏁 تجاوز الحد! الانتقال إلى المجموعة ${this.groupCounter}`);
        }
        
        await writeToFirebase('System/stats', {
            currentGroup: this.groupCounter,
            currentGroupCount: this.currentGroupCount,
            totalManga: this.totalMangaSaved,
            lastUpdate: Date.now()
        });
        
        console.log(`📊 المجموعة ${this.groupCounter}: ${this.currentGroupCount}/${SYSTEM_CONFIG.MAX_MANGA_PER_GROUP}`);
        
        return this.currentGroupCount;
    }
    
    async getGroupStats() {
        const stats = await readFromFirebase('System/stats') || {};
        this.groupCounter = stats.currentGroup || 1;
        this.currentGroupCount = stats.currentGroupCount || 0;
        this.totalMangaSaved = stats.totalManga || 0;
        return stats;
    }
}

const groupManager = new GroupManager();

// ==================== دوال رفع الصور ====================
async function uploadToImgBB(imageUrl) {
    if (!SYSTEM_CONFIG.USE_IMGBB || !IMGBB_API_KEY) {
        return { success: false, url: imageUrl, message: 'ImgBB غير مفعل' };
    }
    try {
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
        const base64Image = Buffer.from(imageResponse.data, 'binary').toString('base64');
        const formData = new URLSearchParams();
        formData.append('key', IMGBB_API_KEY);
        formData.append('image', base64Image);
        const uploadResponse = await axios.post('https://api.imgbb.com/1/upload', formData, { timeout: 30000 });
        if (uploadResponse.data.success) {
            return { success: true, url: uploadResponse.data.data.url };
        }
        return { success: false, url: imageUrl, message: uploadResponse.data.error?.message || 'Upload failed' };
    } catch (error) {
        console.error(`❌ فشل رفع الصورة لـ ImgBB: ${error.message}`);
        return { success: false, url: imageUrl, message: error.message };
    }
}

// ==================== إعدادات الجلب ====================
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

const REFERERS = [
    'https://www.google.com/',
    'https://www.bing.com/',
    'https://azoramoon.com/',
    ''
];

const PROXIES = [
    '',
    'https://cors-anywhere.herokuapp.com/',
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?',
    'https://proxy.cors.sh/'
];

function getRandomHeaders() {
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const referer = REFERERS[Math.floor(Math.random() * REFERERS.length)];
    
    return {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Referer': referer,
        'DNT': '1'
    };
}

async function tryAllProxies(url) {
    const errors = [];
    
    for (const proxy of PROXIES) {
        try {
            let targetUrl = url;
            if (proxy) {
                targetUrl = proxy + encodeURIComponent(url);
            }
            
            const response = await axios.get(targetUrl, {
                headers: getRandomHeaders(),
                timeout: 20000,
                maxRedirects: 3,
                validateStatus: (status) => status >= 200 && status < 500
            });
            
            if (response.status === 200) {
                return response.data;
            } else {
                errors.push(`${proxy ? 'بروكسي' : 'مباشر'}: ${response.status}`);
            }
            
        } catch (error) {
            errors.push(`${proxy ? 'بروكسي' : 'مباشر'}: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error(`فشلت جميع محاولات الجلب:\n${errors.join('\n')}`);
}

// ==================== منطق استخراج المانجا ====================
function extractManga(html, pageNum) {
    const $ = cheerio.load(html);
    const mangaList = [];
    const selectors = [
        '.c-tabs-item__content .tab-content-area .row .col-sm-6',
        '.c-tabs-item__content .tab-content-area .row .col-6',
        '.page-content-listing .row .col-6',
        '.post-list .post-item'
    ];
    let usedSelector = '';
    let foundCount = 0;

    for (const selector of selectors) {
        const elements = $(selector);
        if (elements.length > 0) {
            usedSelector = selector;
            foundCount = elements.length;

            elements.each((i, element) => {
                const $el = $(element);
                
                let mangaUrl = $el.find('.post-title a').attr('href');
                let title = $el.find('.post-title a').text().trim();
                
                if (!mangaUrl) mangaUrl = $el.find('a').first().attr('href');
                if (!title) title = $el.find('a').first().text().trim();

                let coverUrl = $el.find('.item-thumb img').attr('src') || $el.find('.item-thumb img').attr('data-src');
                if (!coverUrl) coverUrl = $el.find('img').attr('src') || $el.find('img').attr('data-src');
                if (!coverUrl && mangaUrl) {
                    coverUrl = 'https://via.placeholder.com/175x238?text=No+Cover';
                }
                
                let latestChapter = $el.find('.chapter-item .chapter a').text().trim() || $el.find('.chapter a').text().trim() || $el.find('.chapter-text').text().trim() || 'غير معروف';
                
                if (title && mangaUrl) {
                    const mangaId = mangaUrl.split('/').filter(Boolean).pop();
                    
                    mangaList.push({
                        id: mangaId,
                        title,
                        url: mangaUrl,
                        cover: coverUrl,
                        latestChapter,
                        status: 'pending_chapters',
                        scrapedAt: Date.now(),
                        page: pageNum
                    });
                }
            });
            break;
        }
    }
    
    return mangaList;
}

// ==================== منطق حفظ المانجا في المجموعات ====================
async function saveMangaToGroup(manga) {
    try {
        await groupManager.initialize();
        const currentGroup = await groupManager.getCurrentGroup();
        
        let existingManga = null;
        let existingGroup = null;
        
        const mangaInCurrentGroup = await readFromFirebase(`${currentGroup}/${manga.id}`);
        if (mangaInCurrentGroup) {
            existingManga = mangaInCurrentGroup;
            existingGroup = currentGroup;
        }
        
        if (existingManga) {
            console.log(`🔍 موجودة في ${existingGroup}: ${manga.title}`);
            
            if (existingManga.latestChapter !== manga.latestChapter) {
                console.log(`🔄 تحديث فصل: ${manga.latestChapter}`);
                
                existingManga.latestChapter = manga.latestChapter;
                existingManga.updatedAt = Date.now();
                existingManga.status = 'pending_chapters';
                
                await writeToFirebase(`${existingGroup}/${manga.id}`, existingManga);
                
                await notifyServer2(manga.id, existingGroup);
                return { saved: true, updated: true, group: existingGroup };
            }
            
            return { saved: false, updated: false, group: existingGroup };
        }
        
        console.log(`✨ جديد: ${manga.title}`);
        console.log(`📁 الحفظ في: ${currentGroup}`);
        
        const mangaData = {
            ...manga,
            group: currentGroup,
            savedAt: Date.now(),
            mangaNumber: groupManager.totalMangaSaved + 1
        };
        
        await writeToFirebase(`${currentGroup}/${manga.id}`, mangaData);
        
        const newCount = await groupManager.incrementGroupCount();
        
        console.log(`✅ تم الحفظ. العداد: ${newCount}/${SYSTEM_CONFIG.MAX_MANGA_PER_GROUP}`);
        
        await notifyServer2(manga.id, currentGroup);
        
        return { 
            saved: true, 
            updated: false, 
            group: currentGroup,
            count: newCount,
            total: groupManager.totalMangaSaved 
        };
        
    } catch (error) {
        console.error(`❌ خطأ في حفظ المانجا ${manga.title}:`, error.message);
        return { saved: false, error: error.message };
    }
}

// ==================== إخطار البوت 2 ====================
async function notifyServer2(mangaId, groupName) {
    const url = `${SERVER_2_URL}/process-manga/${mangaId}?group=${groupName}`;
    console.log(`🔔 إخطار البوت 2: ${mangaId} (${groupName})`);
    
    try {
        await axios.get(url, { timeout: 10000 });
        console.log(`✅ تم الإخطار بنجاح`);
    } catch (error) {
        console.error(`⚠️ فشل إخطار البوت 2: ${error.message}`);
    }
}

// ==================== الجلب المستمر ====================
async function startContinuousScraping() {
    await groupManager.getGroupStats();
    
    let config = await readFromFirebase('Config/Scraper') || { 
        currentPage: 1, 
        isComplete: "false",
        totalPagesScraped: 0,
        lastScraped: Date.now()
    };
    
    let page = config.isComplete === "true" ? 1 : config.currentPage;
    let totalMangaCount = 0;
    let newMangaCount = 0;

    console.log(`\n🚀 بدء الجلب. الصفحة: ${page}, مكتمل: ${config.isComplete}`);
    console.log(`📊 الإحصائيات: ${groupManager.totalMangaSaved} مانجا في ${groupManager.groupCounter} مجموعات`);

    while (true) {
        const url = `https://azoramoon.com/page/${page}/?m_orderby=latest`;
        console.log(`\n📄 جلب الصفحة ${page} من ${SYSTEM_CONFIG.MAX_PAGES}`);
        
        try {
            const html = await tryAllProxies(url);
            const mangaOnPage = extractManga(html, page);

            if (mangaOnPage.length === 0) {
                console.log(`⚠️ الصفحة ${page} فارغة`);
                if (config.isComplete === "false") {
                    config.isComplete = "true";
                    config.currentPage = 1;
                    await writeToFirebase('Config/Scraper', config);
                }
                break;
            }

            let pageNewManga = 0;
            for (const manga of mangaOnPage) {
                const result = await saveMangaToGroup(manga);
                
                if (result.saved) {
                    pageNewManga++;
                    newMangaCount++;
                }
                
                await new Promise(resolve => setTimeout(resolve, SYSTEM_CONFIG.DELAY_BETWEEN_MANGA));
            }
            
            totalMangaCount += mangaOnPage.length;
            console.log(`✅ الصفحة ${page}: ${mangaOnPage.length} مانجا، ${pageNewManga} جديدة`);

            if (config.isComplete === "false") {
                page++;
                config.currentPage = page;
                config.totalPagesScraped = (config.totalPagesScraped || 0) + 1;
                
                if (page > SYSTEM_CONFIG.MAX_PAGES) {
                    config.isComplete = "true";
                    config.currentPage = 1;
                    config.completedAt = Date.now();
                    await writeToFirebase('Config/Scraper', config);
                    console.log("🏁 وصلت للصفحة 67. مكتمل.");
                    break;
                }
                
                await writeToFirebase('Config/Scraper', config);
            } else {
                console.log("ℹ️ الأرشفة مكتملة. جاري فحص الصفحة الأولى");
                break;
            }
            
            console.log(`⏳ انتظار ${SYSTEM_CONFIG.DELAY_BETWEEN_PAGES / 1000} ثواني`);
            await new Promise(resolve => setTimeout(resolve, SYSTEM_CONFIG.DELAY_BETWEEN_PAGES));

        } catch (error) {
            console.error(`❌ خطأ في الصفحة ${page}:`, error.message);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    
    console.log(`\n📊 النتائج النهائية:`);
    console.log(`📚 إجمالي المانجا: ${totalMangaCount}`);
    console.log(`🆕 مانجا جديدة: ${newMangaCount}`);
    console.log(`📁 عدد المجموعات: ${groupManager.groupCounter}`);
    console.log(`🏁 الحالة: ${config.isComplete === "true" ? "مكتمل" : "نشط"}`);
    
    return { 
        totalMangaCount, 
        newMangaCount, 
        totalGroups: groupManager.groupCounter,
        status: config.isComplete 
    };
}

// ==================== دالة لتصحيح البيانات الحالية ====================
async function fixExistingData() {
    console.log('\n🔧 بدء تصحيح البيانات الحالية...');
    
    try {
        const stats = await readFromFirebase('System/stats');
        if (!stats) return;
        
        console.log(`📊 البيانات الحالية:`);
        console.log(`   • currentGroup: ${stats.currentGroup}`);
        console.log(`   • currentGroupCount: ${stats.currentGroupCount}`);
        console.log(`   • totalManga: ${stats.totalManga}`);
        
        if (stats.currentGroupCount > SYSTEM_CONFIG.MAX_MANGA_PER_GROUP) {
            const correctGroup = Math.ceil(stats.totalManga / SYSTEM_CONFIG.MAX_MANGA_PER_GROUP);
            const correctCount = stats.totalManga % SYSTEM_CONFIG.MAX_MANGA_PER_GROUP || SYSTEM_CONFIG.MAX_MANGA_PER_GROUP;
            
            console.log(`⚠️ تصحيح مطلوب:`);
            console.log(`   • المجموعة الصحيحة: ${correctGroup}`);
            console.log(`   • العدد الصحيح: ${correctCount}`);
            
            await writeToFirebase('System/stats', {
                currentGroup: correctGroup,
                currentGroupCount: correctCount,
                totalManga: stats.totalManga,
                correctedAt: Date.now()
            });
            
            console.log(`✅ تم التصحيح`);
        }
        
    } catch (error) {
        console.error('❌ خطأ في تصحيح البيانات:', error.message);
    }
}

// ==================== واجهات API ====================
const app = express();

app.get('/start-scraping', async (req, res) => {
    try {
        startContinuousScraping();
        res.json({ 
            success: true, 
            message: 'بدأت عملية الجلب',
            system: SYSTEM_CONFIG
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/stats', async (req, res) => {
    try {
        const stats = await groupManager.getGroupStats();
        const config = await readFromFirebase('Config/Scraper') || {};
        
        res.json({
            success: true,
            system: SYSTEM_CONFIG,
            stats: stats,
            config: config,
            groups: Array.from({length: stats.currentGroup || 1}, (_, i) => 
                `${SYSTEM_CONFIG.GROUP_PREFIX}_${i + 1}`
            )
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/reset', async (req, res) => {
    try {
        await writeToFirebase('Config/Scraper', {
            currentPage: 1,
            isComplete: "false",
            resetAt: Date.now()
        });
        
        await writeToFirebase('System/stats', {
            totalManga: 0,
            currentGroup: 1,
            currentGroupCount: 0,
            resetAt: Date.now()
        });
        
        res.json({ 
            success: true, 
            message: 'تم إعادة التعيين بنجاح' 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/fix-groups', async (req, res) => {
    try {
        await fixExistingData();
        
        await writeToFirebase('System/stats', {
            currentGroup: 3,
            currentGroupCount: 16,
            totalManga: 116,
            manuallyFixed: Date.now()
        });
        
        res.json({ 
            success: true, 
            message: 'تم تصحيح المجموعات يدوياً',
            newStats: {
                currentGroup: 3,
                currentGroupCount: 16,
                totalManga: 116
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send(`
        <h1>🚀 البوت 1</h1>
        <p><strong>نظام المجموعات:</strong> ${SYSTEM_CONFIG.GROUP_PREFIX}_1 إلى ${SYSTEM_CONFIG.GROUP_PREFIX}_52</p>
        <p><strong>عدد الصفحات:</strong> ${SYSTEM_CONFIG.MAX_PAGES} صفحة كاملة</p>
        <p><strong>المانجا في كل مجموعة:</strong> ${SYSTEM_CONFIG.MAX_MANGA_PER_GROUP}</p>
        <p><strong>ImgBB:</strong> ${SYSTEM_CONFIG.USE_IMGBB ? 'مفعل' : 'معطل'}</p>
        
        <h3>الروابط:</h3>
        <p><a href="/start-scraping">/start-scraping</a> - بدء الجلب</p>
        <p><a href="/stats">/stats</a> - الإحصائيات</p>
        <p><a href="/reset">/reset</a> - إعادة التعيين</p>
        <p><a href="/fix-groups">/fix-groups</a> - تصحيح المجموعات</p>
    `);
});

app.listen(PORT, () => {
    console.log(`\n✅ البوت 1 يعمل على المنفذ ${PORT}`);
    console.log(`📊 النظام:`);
    console.log(`   • الصفحات: ${SYSTEM_CONFIG.MAX_PAGES}`);
    console.log(`   • المانجا/مجموعة: ${SYSTEM_CONFIG.MAX_MANGA_PER_GROUP}`);
    console.log(`   • البادئة: ${SYSTEM_CONFIG.GROUP_PREFIX}_#`);
    
    setTimeout(async () => {
        await fixExistingData();
        
        const config = await readFromFirebase('Config/Scraper');
        if (config && config.isComplete !== "true") {
            console.log('🔄 استئناف الجلب من الحالة السابقة...');
            startContinuousScraping();
        } else {
            console.log('⏸️ الجلب مكتمل أو غير نشط');
        }
    }, 3000);
});
