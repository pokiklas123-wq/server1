const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

// ==================== إعدادات هامة ====================
const PORT = process.env.PORT || 3000;
// ضع رابط البوت الثاني هنا بعد رفعه
const SERVER_2_URL = "https://server-2-n9s3.onrender.com"; 
const DATABASE_SECRETS = "KXPNxnGZDA1BGnzs4kZIA45o6Vr9P5nJ3Z01X4bt";
const DATABASE_URL = "https://hackerdz-b1bdf.firebaseio.com";

const SYSTEM_CONFIG = {
    MAX_MANGA_PER_GROUP: 50,
    MAX_PAGES: 67,
    DELAY_BETWEEN_PAGES: 5000,
    DELAY_BETWEEN_MANGA: 2000, // زدنا الوقت قليلاً لعدم الضغط
    GROUP_PREFIX: 'HomeManga'
};

// ==================== دوال Firebase ====================
const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

async function writeToFirebase(path, data) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try { await axios.put(url, data); } catch (e) { console.error(`❌ خطأ Firebase Write: ${e.message}`); }
}

async function readFromFirebase(path) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try { const res = await axios.get(url); return res.data; } 
    catch (e) { return null; }
}

// ==================== إدارة المجموعات ====================
class GroupManager {
    constructor() {
        this.groupCounter = 1;
        this.currentGroupCount = 0;
    }
    
    async initialize() {
        const stats = await readFromFirebase('System/stats');
        if (stats) {
            this.groupCounter = stats.currentGroup || 1;
            this.currentGroupCount = stats.currentGroupCount || 0;
        }
    }
    
    async getCurrentGroup() {
        if (this.currentGroupCount >= SYSTEM_CONFIG.MAX_MANGA_PER_GROUP) {
            this.groupCounter++;
            this.currentGroupCount = 0;
        }
        return `${SYSTEM_CONFIG.GROUP_PREFIX}_${this.groupCounter}`;
    }
    
    async incrementGroupCount() {
        this.currentGroupCount++;
        await writeToFirebase('System/stats', {
            currentGroup: this.groupCounter,
            currentGroupCount: this.currentGroupCount,
            totalManga: (await readFromFirebase('System/stats/totalManga') || 0) + 1,
            lastUpdate: Date.now()
        });
        return this.currentGroupCount;
    }
}
const groupManager = new GroupManager();

// ==================== أدوات الجلب (Headers) ====================
// هذه الرؤوس ضرورية جداً ليعمل البوت كأنه متصفح
const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': 'https://www.google.com/',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
};

async function fetchHtml(url) {
    try {
        const response = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 15000 });
        return response.data;
    } catch (error) {
        throw new Error(`فشل الجلب: ${error.message}`);
    }
}

// ==================== المنطق الرئيسي ====================
function extractManga(html, pageNum) {
    const $ = cheerio.load(html);
    const mangaList = [];
    
    $('.c-tabs-item__content .tab-content-area .row .col-6, .post-item').each((i, el) => {
        const $el = $(el);
        const url = $el.find('.post-title a').attr('href') || $el.find('a').first().attr('href');
        const title = $el.find('.post-title a').text().trim() || $el.find('a').first().text().trim();
        let cover = $el.find('img').attr('src') || $el.find('img').attr('data-src');
        const latestChapter = $el.find('.chapter-item .chapter a').text().trim() || 'New';

        if (url && title) {
            const id = url.split('/').filter(Boolean).pop();
            mangaList.push({ id, title, url, cover, latestChapter, page: pageNum });
        }
    });
    return mangaList;
}

async function notifyServer2(mangaId, groupName, mangaUrl) {
    // نرسل الرابط أيضاً لتقليل الضغط على البوت الثاني في البحث عنه
    const encodedUrl = encodeURIComponent(mangaUrl);
    const target = `${SERVER_2_URL}/process-full/${mangaId}?group=${groupName}&url=${encodedUrl}`;
    
    console.log(`🔔 إرسال للبوت 2: ${mangaId}`);
    try {
        // لا ننتظر الرد (Fire and Forget) لكي لا يتوقف البوت الأول
        axios.get(target, { timeout: 5000 }).catch(e => console.log(`⚠️ البوت 2 لم يرد بسرعة (طبيعي): ${e.message}`));
    } catch (error) {
        console.error(`❌ فشل الاتصال بالبوت 2`);
    }
}

async function saveAndNotify(manga) {
    await groupManager.initialize();
    const currentGroup = await groupManager.getCurrentGroup();
    
    // التحقق مما إذا كانت موجودة (تحديث فقط) أو جديدة
    // ملاحظة: لتقليل القراءة، سنفترض أنها جديدة أو نعتمد على البوت 2 للتحقق الدقيق
    // لكن هنا سنكتب البيانات الأساسية
    
    const path = `${currentGroup}/${manga.id}`;
    const existing = await readFromFirebase(path);
    
    let shouldNotify = false;
    
    if (!existing) {
        console.log(`✨ مانجا جديدة: ${manga.title} -> ${currentGroup}`);
        await writeToFirebase(path, { ...manga, group: currentGroup, savedAt: Date.now() });
        await groupManager.incrementGroupCount();
        shouldNotify = true;
    } else if (existing.latestChapter !== manga.latestChapter) {
        console.log(`🔄 تحديث فصل: ${manga.title}`);
        await writeToFirebase(path, { ...existing, latestChapter: manga.latestChapter, updatedAt: Date.now() });
        shouldNotify = true;
    } else {
        console.log(`✅ لا تغيير: ${manga.title}`);
    }

    if (shouldNotify) {
        await notifyServer2(manga.id, currentGroup, manga.url);
    }
}

async function startScraping() {
    let page = 1;
    console.log("🚀 بدء عملية المسح...");
    
    while (page <= SYSTEM_CONFIG.MAX_PAGES) {
        const url = `https://azoramoon.com/page/${page}/?m_orderby=latest`;
        console.log(`\n📄 صفحة ${page}`);
        
        try {
            const html = await fetchHtml(url);
            const mangas = extractManga(html, page);
            
            if (mangas.length === 0) break;

            for (const manga of mangas) {
                await saveAndNotify(manga);
                await new Promise(r => setTimeout(r, SYSTEM_CONFIG.DELAY_BETWEEN_MANGA));
            }
            
            page++;
            await new Promise(r => setTimeout(r, SYSTEM_CONFIG.DELAY_BETWEEN_PAGES));
        } catch (e) {
            console.error(`❌ خطأ في الصفحة ${page}: ${e.message}`);
            await new Promise(r => setTimeout(r, 10000)); // انتظار عند الخطأ
        }
    }
}

// ==================== الخادم ====================
const app = express();

app.get('/start', (req, res) => {
    startScraping();
    res.send('Started scraping process.');
});

app.get('/', (req, res) => res.send('Bot 1 is Running. Use /start to begin.'));

app.listen(PORT, () => {
    console.log(`✅ البوت 1 يعمل على المنفذ ${PORT}`);
    // بدء تلقائي بعد دقيقة
    setTimeout(startScraping, 60000);
});
