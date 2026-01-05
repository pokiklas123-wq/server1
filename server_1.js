const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
require('dotenv').config();

const PORT = process.env.PORT || 10000;
const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;
const SERVER_2_URL = process.env.SERVER_2_URL;

const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// ==================== إعدادات الحماية الأصلية ====================
const ADVANCED_PROXIES = [
    { url: '', name: 'Direct' },
    { url: 'https://cors-anywhere.herokuapp.com/', name: 'Cors Anywhere' },
    { url: 'https://api.allorigins.win/raw?url=', name: 'All Origins' },
    { url: 'https://corsproxy.io/?', name: 'Cors Proxy' },
    { url: 'https://proxy.cors.sh/', name: 'Cors.sh' },
    { url: 'https://api.codetabs.com/v1/proxy?quest=', name: 'CodeTabs' },
    { url: 'https://thingproxy.freeboard.io/fetch/', name: 'ThingProxy' },
    { url: 'https://yacdn.org/proxy/', name: 'Yacdn' }
];

function getAdvancedHeaders() {
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    ];
    const referers = ['https://www.google.com/', 'https://www.bing.com/', 'https://duckduckgo.com/', 'https://azoramoon.com/', 'https://www.facebook.com/'];
    return {
        'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        'DNT': '1',
        'Referer': referers[Math.floor(Math.random() * referers.length)]
    };
}

async function fetchPageWithRetry(url, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const proxy = ADVANCED_PROXIES[Math.floor(Math.random() * ADVANCED_PROXIES.length)];
        try {
            let targetUrl = proxy.url ? proxy.url + encodeURIComponent(url) : url;
            const response = await axios.get(targetUrl, {
                headers: getAdvancedHeaders(),
                timeout: 25000,
                validateStatus: (status) => status >= 200 && status < 500
            });
            if (response.status === 200) return response.data;
        } catch (error) {}
        await new Promise(r => setTimeout(r, 2000 * attempt));
    }
    throw new Error('فشلت جميع محاولات الجلب');
}

// ==================== دوال Firebase ====================
async function writeToFirebase(path, data) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    await axios.put(url, data);
}

async function readFromFirebase(path) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (e) { return null; }
}

// ==================== المحرك الذكي ====================
let isRunning = false;

async function notifyServer2(mangaId) {
    if (!SERVER_2_URL) return;
    try { 
        // استخدام مسار مطلق إذا كان الرابط لا يبدأ بـ http
        const target = SERVER_2_URL.startsWith('http') ? SERVER_2_URL : `https://${SERVER_2_URL}`;
        await axios.get(`${target}/process-manga/${mangaId}`, { timeout: 10000 }); 
    } catch (e) {
        console.log(`⚠️ فشل إخطار السيرفر الثاني للمانجا ${mangaId}: ${e.message}`);
    }
}

// دالة لاستخراج المعرف من الرابط (Slug) ليكون أكثر دقة
function generateMangaId(url, title) {
    try {
        // محاولة استخراج الاسم من الرابط (slug)
        const parts = url.split('/').filter(p => p);
        const slug = parts[parts.length - 1];
        if (slug && slug.length > 3) return slug;
    } catch (e) {}
    // fallback للمعرف القديم إذا فشل الاستخراج
    return crypto.createHash('md5').update(url).digest('hex').substring(0, 12);
}

async function smartEngine() {
    if (isRunning) return;
    isRunning = true;
    console.log('🚀 بدء المحرك الذكي...');

    try {
        let state = await readFromFirebase('SystemState/Scraper') || { mode: 'archiving', lastPage: 0, isArchiveDone: false };

        if (!state.isArchiveDone) {
            console.log(`📦 طور الأرشفة: البدء من الصفحة ${state.lastPage + 1}`);
            let page = state.lastPage + 1;
            
            while (true) {
                console.log(`📄 جلب الصفحة ${page}...`);
                try {
                    const html = await fetchPageWithRetry(`https://azoramoon.com/page/${page}/?m_orderby=latest`);
                    const $ = cheerio.load(html);
                    const mangaList = [];
                    
                    $('.c-tabs-item__content .tab-content-area .row .col-sm-6, .page-content-listing .row .col-6').each((i, el) => {
                        const url = $(el).find('.post-title a').attr('href');
                        const title = $(el).find('.post-title a').text().trim();
                        const latest = $(el).find('.chapter-item .chapter a').first().text().trim();
                        if (url && title) {
                            const id = generateMangaId(url, title);
                            mangaList.push({ id, title, url, latestChapter: latest, scrapedAt: Date.now(), page });
                        }
                    });

                    if (mangaList.length === 0) {
                        state.isArchiveDone = true;
                        state.mode = 'monitoring';
                        await writeToFirebase('SystemState/Scraper', state);
                        break;
                    }

                    for (const manga of mangaList) {
                        const existing = await readFromFirebase(`HomeManga/${manga.id}`);
                        if (!existing || existing.latestChapter !== manga.latestChapter) {
                            await writeToFirebase(`HomeManga/${manga.id}`, manga);
                            // إضافة حالة pending هنا
                            await writeToFirebase(`Jobs/${manga.id}`, { 
                                mangaUrl: manga.url, 
                                status: 'waiting_chapters', 
                                title: manga.title,
                                pending: true, // إضافة الحقل المطلوب
                                createdAt: Date.now()
                            });
                            await notifyServer2(manga.id);
                        }
                    }

                    state.lastPage = page;
                    await writeToFirebase('SystemState/Scraper', state);
                    page++;
                    await new Promise(r => setTimeout(r, 3000));
                } catch (e) { break; }
            }
        }

        if (state.isArchiveDone) {
            console.log('👀 طور المراقبة: فحص الصفحة 1...');
            try {
                const html = await fetchPageWithRetry(`https://azoramoon.com/page/1/?m_orderby=latest`);
                const $ = cheerio.load(html);
                const items = $('.c-tabs-item__content .tab-content-area .row .col-sm-6, .page-content-listing .row .col-6').toArray();
                
                for (const el of items) {
                    const url = $(el).find('.post-title a').attr('href');
                    const title = $(el).find('.post-title a').text().trim();
                    const latest = $(el).find('.chapter-item .chapter a').first().text().trim();
                    if (url && title) {
                        const id = generateMangaId(url, title);
                        const existing = await readFromFirebase(`HomeManga/${id}`);
                        if (!existing || existing.latestChapter !== latest) {
                            const manga = { id, title, url, latestChapter: latest, scrapedAt: Date.now(), page: 1 };
                            await writeToFirebase(`HomeManga/${id}`, manga);
                            await writeToFirebase(`Jobs/${id}`, { 
                                mangaUrl: url, 
                                status: 'waiting_chapters', 
                                title,
                                pending: true, // إضافة الحقل المطلوب
                                createdAt: Date.now()
                            });
                            await notifyServer2(id);
                        }
                    }
                }
            } catch (e) {}
        }
    } finally { isRunning = false; }
}

const app = express();
app.get('/start-scraping', (req, res) => { smartEngine(); res.json({ success: true }); });
app.get('/', (req, res) => { res.send('<h1>🛡️ البوت 1 المتطور V3 - Fixed</h1>'); });
app.listen(PORT, () => {
    setInterval(smartEngine, 1000 * 60 * 5);
    smartEngine();
});
