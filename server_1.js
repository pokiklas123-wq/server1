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

// ==================== دالة رفع الصور إلى ImgBB ====================
async function uploadToImgBB(imageUrl) {
    if (!IMGBB_API_KEY) {
        console.log('⚠️ IMGBB_API_KEY مفقود. سيتم استخدام الرابط الأصلي.');
        return { success: false, url: imageUrl, message: 'API key missing' };
    }
    try {
        const imageResponse = await axios.get(imageUrl, { 
            responseType: 'arraybuffer', 
            timeout: 20000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const base64Image = Buffer.from(imageResponse.data, 'binary').toString('base64');
        const formData = new URLSearchParams();
        formData.append('key', IMGBB_API_KEY);
        formData.append('image', base64Image);
        const uploadResponse = await axios.post('https://api.imgbb.com/1/upload', formData, { 
            timeout: 30000,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        if (uploadResponse.data.success) {
            return { success: true, url: uploadResponse.data.data.url };
        }
        return { success: false, url: imageUrl, message: uploadResponse.data.error?.message || 'Upload failed' };
    } catch (error) {
        console.error(`❌ فشل رفع الغلاف لـ ImgBB: ${error.message}`);
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
            
            console.log(`🔄 محاولة [${proxy ? 'بروكسي' : 'مباشر'}]`);
            
            const response = await axios.get(targetUrl, {
                headers: getRandomHeaders(),
                timeout: 20000,
                maxRedirects: 3,
                validateStatus: (status) => status >= 200 && status < 500
            });
            
            if (response.status === 200) {
                console.log(`✅ نجح [${proxy ? 'بروكسي' : 'مباشر'}]`);
                return response.data;
            } else {
                errors.push(`${proxy ? 'بروكسي' : 'مباشر'}: ${response.status}`);
            }
            
        } catch (error) {
            errors.push(`${proxy ? 'بروكسي' : 'مباشر'}: ${error.message}`);
            console.log(`❌ فشل [${proxy ? 'بروكسي' : 'مباشر'}]: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    throw new Error(`فشلت جميع محاولات الجلب:\n${errors.join('\n')}`);
}

// ==================== منطق الاستخراج ====================
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
            console.log(`✅ وجد ${foundCount} مانجا`);

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

// ==================== منطق التتابع والاتصال ====================
async function notifyServer2(mangaId) {
    const url = `${SERVER_2_URL}/process-manga/${mangaId}`;
    console.log(`\n🔔 إخطار البوت 2 لمعالجة المانجا: ${mangaId}`);
    
    try {
        const response = await axios.get(url, { timeout: 15000 });
        console.log(`✅ استجابة البوت 2: ${response.data.message || 'تم الإخطار'}`);
    } catch (error) {
        console.error(`❌ فشل إخطار البوت 2: ${error.message}`);
    }
}

async function startContinuousScraping() {
    let config = await readFromFirebase('Config/Scraper') || { currentPage: 1, isComplete: "false" };
    let page = config.isComplete === "true" ? 1 : config.currentPage;
    let totalMangaCount = 0;
    let newMangaCount = 0;
    const MAX_PAGES = 67;

    console.log(`\n🚀 بدء الجلب. الصفحة: ${page}, مكتمل: ${config.isComplete}`);

    while (true) {
        const url = `https://azoramoon.com/page/${page}/?m_orderby=latest`;
        console.log(`\n📄 جلب الصفحة ${page}`);
        
        try {
            const html = await tryAllProxies(url);
            const mangaOnPage = extractManga(html, page);

            if (mangaOnPage.length === 0) {
                console.log(`⚠️ الصفحة ${page} فارغة`);
                if (config.isComplete === "false") {
                    config.isComplete = "true";
                    await writeToFirebase('Config/Scraper', config);
                }
                break;
            }

            let pageNewManga = 0;
            for (const manga of mangaOnPage) {
                const existingManga = await readFromFirebase(`HomeManga/${manga.id}`);
                
                if (!existingManga || existingManga.latestChapter !== manga.latestChapter) {
                    console.log(`✨ معالجة: ${manga.title}`);
                    
                    let imgbbCover = manga.cover;
                    const uploadResult = await uploadToImgBB(manga.cover);
                    if (uploadResult.success) {
                        imgbbCover = uploadResult.url;
                    }

                    const mangaData = {
                        ...manga,
                        imgbbCover: imgbbCover,
                        originalCover: manga.cover,
                        updatedAt: Date.now()
                    };

                    await writeToFirebase(`HomeManga/${manga.id}`, mangaData);
                    
                    await writeToFirebase(`Jobs/${manga.id}`, {
                        mangaUrl: manga.url,
                        status: 'waiting_chapters',
                        createdAt: Date.now(),
                        title: manga.title
                    });
                    
                    pageNewManga++;
                    newMangaCount++;
                    
                    await notifyServer2(manga.id);
                }
            }
            
            totalMangaCount += mangaOnPage.length;
            console.log(`✅ الصفحة ${page}: ${mangaOnPage.length} مانجا، ${pageNewManga} جديدة`);

            if (config.isComplete === "false") {
                page++;
                config.currentPage = page;
                if (page > MAX_PAGES) {
                    config.isComplete = "true";
                    config.currentPage = 1;
                    await writeToFirebase('Config/Scraper', config);
                    console.log("🏁 وصلت للصفحة 67. مكتمل.");
                    break;
                }
                await writeToFirebase('Config/Scraper', config);
            } else {
                console.log("ℹ️ الأرشفة مكتملة. جاري فحص الصفحة الأولى");
                break;
            }
            
            const waitTime = 5000;
            console.log(`⏳ انتظار ${waitTime / 1000} ثواني`);
            await new Promise(resolve => setTimeout(resolve, waitTime));

        } catch (error) {
            console.error(`❌ خطأ في الصفحة ${page}:`, error.message);
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    
    return { totalMangaCount, newMangaCount };
}

// ==================== واجهات API ====================
const app = express();

app.get('/start-scraping', async (req, res) => {
    try {
        startContinuousScraping();
        res.json({ success: true, message: 'بدأت عملية الجلب' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/', (req, res) => {
    res.send(`<h1>🛡️ البوت 1 - جالب المانجا</h1><p>استخدم <a href="/start-scraping">/start-scraping</a> للبدء.</p>`);
});

app.listen(PORT, () => {
    console.log(`\n✅ البوت 1 يعمل على المنفذ ${PORT}`);
    startContinuousScraping();
});