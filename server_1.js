const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;

const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// 📱 قائمة User-Agents متنوعة
const USER_AGENTS = [
    // Chrome على Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Chrome على Mac
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Firefox على Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    // Safari على Mac
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    // Edge على Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    // Chrome على Android
    'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    // Safari على iPhone
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

// 🌐 قائمة Referers مختلفة
const REFERERS = [
    'https://www.google.com/',
    'https://www.bing.com/',
    'https://duckduckgo.com/',
    'https://www.yahoo.com/',
    'https://www.facebook.com/',
    'https://twitter.com/',
    'https://www.reddit.com/',
    'https://azoramoon.com/',
    ''
];

// 🔄 وكالات بروكسي مجانية (قد تعمل أو لا)
const PROXIES = [
    '', // بدون بروكسي أولاً
    'https://cors-anywhere.herokuapp.com/',
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?',
    'https://proxy.cors.sh/'
];

// 🔍 قائمة منافذ بديلة للموقع
const SITE_VARIANTS = [
    'https://azoramoon.com/',
    'https://www.azoramoon.com/',
    'http://azoramoon.com/',
    'http://www.azoramoon.com/'
];

// دالة للحصول على رؤوس عشوائية
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
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'max-age=0',
        'DNT': '1',
        'Referer': referer,
        'Pragma': 'no-cache',
        'TE': 'trailers'
    };
}

// 🔄 دالة محاولة جميع البروكسيات
async function tryAllProxies(url, method = 'GET', data = null) {
    const errors = [];
    
    for (const proxy of PROXIES) {
        try {
            let targetUrl = url;
            
            if (proxy) {
                if (proxy.includes('?')) {
                    targetUrl = proxy + encodeURIComponent(url);
                } else {
                    targetUrl = proxy + url;
                }
            }
            
            console.log(`🔗 المحاولة مع: ${proxy || 'بدون بروكسي'}`);
            
            const config = {
                headers: getRandomHeaders(),
                timeout: 20000,
                maxRedirects: 5,
                validateStatus: function (status) {
                    return status < 500; // قبول كل شيء أقل من 500
                }
            };
            
            let response;
            if (method === 'POST' && data) {
                response = await axios.post(targetUrl, data, config);
            } else {
                response = await axios.get(targetUrl, config);
            }
            
            if (response.status === 200 || response.status === 304) {
                console.log(`✅ نجح مع ${proxy || 'بدون بروكسي'} - الحالة: ${response.status}`);
                return response.data;
            } else if (response.status === 403 || response.status === 429) {
                console.log(`⚠️ حظر مع ${proxy || 'بدون بروكسي'} - الحالة: ${response.status}`);
                continue;
            } else {
                console.log(`ℹ️ استجابة ${response.status} مع ${proxy || 'بدون بروكسي'}`);
                return response.data;
            }
        } catch (error) {
            errors.push(`${proxy || 'بدون بروكسي'}: ${error.message}`);
            console.log(`❌ فشل مع ${proxy || 'بدون بروكسي'}: ${error.message}`);
            
            // تأخير بين المحاولات
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    throw new Error(`فشل جميع البروكسيات:\n${errors.join('\n')}`);
}

// دالة الكتابة إلى Firebase
async function writeToFirebase(path, data) {
    if (!FIXED_DB_URL || !DATABASE_SECRETS) {
        console.log('⚠️ Firebase غير مهيء');
        return null;
    }
    
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    
    try {
        const response = await axios.put(url, data, { 
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('✅ تم الحفظ في Firebase');
        return response.data;
    } catch (error) {
        console.error('❌ خطأ في Firebase:', error.message);
        return null;
    }
}

// دالة جلب الصفحة مع جميع المحاولات
async function fetchPageWithAllMethods(url) {
    console.log(`\n🎯 محاولة جلب: ${url}`);
    
    // المحاولة 1: مباشر مع رؤوس عشوائية
    console.log('\n1️⃣ المحاولة المباشرة مع رؤوس عشوائية');
    try {
        const response = await axios.get(url, {
            headers: getRandomHeaders(),
            timeout: 15000
        });
        console.log(`✅ نجحت المحاولة المباشرة - الحالة: ${response.status}`);
        return response.data;
    } catch (error) {
        console.log(`❌ فشلت المحاولة المباشرة: ${error.message}`);
    }
    
    // المحاولة 2: جميع البروكسيات
    console.log('\n2️⃣ محاولة جميع البروكسيات');
    try {
        const html = await tryAllProxies(url);
        return html;
    } catch (error) {
        console.log(`❌ فشلت جميع البروكسيات: ${error.message}`);
    }
    
    // المحاولة 3: HTTPS->HTTP
    console.log('\n3️⃣ محاولة HTTP بدلاً من HTTPS');
    if (url.startsWith('https://')) {
        const httpUrl = url.replace('https://', 'http://');
        try {
            const response = await axios.get(httpUrl, {
                headers: getRandomHeaders(),
                timeout: 15000
            });
            console.log(`✅ نجحت مع HTTP - الحالة: ${response.status}`);
            return response.data;
        } catch (error) {
            console.log(`❌ فشلت مع HTTP: ${error.message}`);
        }
    }
    
    // المحاولة 4: مع www أو بدون
    console.log('\n4️⃣ محاولة مع/بدون www');
    if (url.includes('azoramoon.com')) {
        const withWWW = url.includes('www.') ? url : url.replace('azoramoon.com', 'www.azoramoon.com');
        const withoutWWW = url.includes('www.') ? url.replace('www.', '') : url;
        
        for (const variant of [withWWW, withoutWWW]) {
            if (variant !== url) {
                try {
                    const response = await axios.get(variant, {
                        headers: getRandomHeaders(),
                        timeout: 15000
                    });
                    console.log(`✅ نجحت مع ${variant} - الحالة: ${response.status}`);
                    return response.data;
                } catch (error) {
                    console.log(`❌ فشلت مع ${variant}: ${error.message}`);
                }
            }
        }
    }
    
    throw new Error('فشلت جميع طرق الجلب');
}

// دالة جلب المانجا
async function scrapeMangaFromPage(pageNum) {
    try {
        const url = `https://azoramoon.com/page/${pageNum}/`;
        console.log(`\n📥 جلب الصفحة ${pageNum}: ${url}`);
        
        const html = await fetchPageWithAllMethods(url);
        const $ = cheerio.load(html);
        
        const mangaList = [];
        
        // 🔍 محاولة جميع الانتقالات المحتملة
        const selectors = [
            '.page-item-detail.manga',
            '.page-item-detail',
            '.manga-item',
            '.item-truyen',
            '.list-truyen .row',
            '.col-xs-12.col-sm-6.col-md-4',
            '.manga-entry',
            '.manga-item-hoz',
            '.manga-card'
        ];
        
        let foundCount = 0;
        let usedSelector = '';
        
        for (const selector of selectors) {
            const elements = $(selector);
            if (elements.length > 0) {
                console.log(`✅ وجد ${elements.length} عنصر بـ "${selector}"`);
                foundCount = elements.length;
                usedSelector = selector;
                
                elements.each((i, element) => {
                    const $el = $(element);
                    
                    // محاولات متعددة للعنوان
                    let title = $el.find('.post-title h3 a').text().trim();
                    if (!title) title = $el.find('h3 a').text().trim();
                    if (!title) title = $el.find('.title a').text().trim();
                    if (!title) title = $el.find('a').first().text().trim();
                    
                    // محاولات متعددة للرابط
                    let mangaUrl = $el.find('.post-title h3 a').attr('href');
                    if (!mangaUrl) mangaUrl = $el.find('h3 a').attr('href');
                    if (!mangaUrl) mangaUrl = $el.find('.title a').attr('href');
                    if (!mangaUrl) mangaUrl = $el.find('a').first().attr('href');
                    
                    // إصلاح الروابط النسبية
                    if (mangaUrl && !mangaUrl.startsWith('http')) {
                        mangaUrl = 'https://azoramoon.com' + (mangaUrl.startsWith('/') ? '' : '/') + mangaUrl;
                    }
                    
                    // محاولات للصورة
                    let coverUrl = $el.find('.item-thumb img').attr('src');
                    if (!coverUrl) coverUrl = $el.find('img').attr('src');
                    if (!coverUrl) coverUrl = $el.find('img').attr('data-src');
                    if (!coverUrl && mangaUrl) {
                        coverUrl = 'https://via.placeholder.com/175x238?text=No+Cover';
                    }
                    
                    // الفصل الأخير
                    let latestChapter = $el.find('.chapter-item .chapter a').text().trim();
                    if (!latestChapter) latestChapter = $el.find('.chapter a').text().trim();
                    if (!latestChapter) latestChapter = $el.find('.chapter-text').text().trim();
                    if (!latestChapter) latestChapter = 'غير معروف';
                    
                    if (title && mangaUrl) {
                        const mangaId = crypto.createHash('md5').update(mangaUrl).digest('hex').substring(0, 12);
                        
                        mangaList.push({
                            id: mangaId,
                            title,
                            url: mangaUrl,
                            cover: coverUrl,
                            latestChapter,
                            status: 'pending',
                            addedAt: Date.now(),
                            selector: usedSelector
                        });
                        
                        console.log(`📖 ${i+1}. ${title}`);
                    }
                });
                break;
            }
        }
        
        if (foundCount === 0) {
            console.log('⚠️ لم أعثر على أي عناصر مانجا');
            console.log('🔍 جرب هذه الانتقالات يدوياً في المتصفح:');
            selectors.forEach(s => console.log(`  - ${s}`));
            
            // حفظ HTML للتحليل
            const fs = require('fs');
            fs.writeFileSync(`debug_page_${pageNum}.html`, html.substring(0, 5000));
            console.log('💾 حفظت جزء من HTML للتحليل');
        }
        
        console.log(`✅ تم استخراج ${mangaList.length} مانجا`);
        return mangaList;
        
    } catch (error) {
        console.error(`❌ خطأ في الصفحة ${pageNum}:`, error.message);
        return [];
    }
}

// API للبدء
app.get('/start-scraping', async (req, res) => {
    try {
        const { pages = 1, delay = 3 } = req.query;
        console.log(`\n🚀 بدء جلب ${pages} صفحة مع تأخير ${delay} ثواني...`);
        
        const allManga = [];
        
        for (let page = 1; page <= pages; page++) {
            console.log(`\n📄 الصفحة ${page}/${pages}`);
            
            const manga = await scrapeMangaFromPage(page);
            if (manga.length > 0) {
                allManga.push(...manga);
                console.log(`✅ تمت الصفحة ${page}: ${manga.length} مانجا`);
            } else {
                console.log(`⚠️ الصفحة ${page}: 0 مانجا`);
            }
            
            // تأخير بين الصفحات
            if (page < pages) {
                const waitTime = delay * 1000;
                console.log(`⏳ انتظار ${delay} ثواني...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
        
        console.log(`\n📊 النتيجة: ${allManga.length} مانجا`);
        
        // حفظ في Firebase
        if (allManga.length > 0) {
            console.log('\n💾 بدء الحفظ في Firebase...');
            
            let savedCount = 0;
            let failedCount = 0;
            
            for (const manga of allManga) {
                try {
                    // حفظ المانجا الرئيسية
                    await writeToFirebase(`HomeManga/${manga.id}`, {
                        title: manga.title,
                        url: manga.url,
                        cover: manga.cover,
                        latestChapter: manga.latestChapter,
                        status: 'pending_chapters',
                        scrapedAt: Date.now(),
                        page: Math.ceil((allManga.indexOf(manga) + 1) / 20)
                    });
                    
                    // إنشاء مهمة
                    await writeToFirebase(`Jobs/${manga.id}`, {
                        mangaUrl: manga.url,
                        status: 'waiting',
                        createdAt: Date.now(),
                        title: manga.title
                    });
                    
                    savedCount++;
                    console.log(`✅ ${savedCount}. ${manga.title}`);
                    
                } catch (error) {
                    failedCount++;
                    console.error(`❌ فشل حفظ ${manga.title}:`, error.message);
                }
                
                // تأخير بين عمليات الحفظ
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            
            res.json({
                success: true,
                message: `تم جلب ${allManga.length} مانجا`,
                details: {
                    total: allManga.length,
                    saved: savedCount,
                    failed: failedCount,
                    sample: allManga.slice(0, 3).map(m => ({ title: m.title, id: m.id }))
                }
            });
            
        } else {
            res.json({
                success: false,
                message: 'لم يتم العثور على أي مانجا',
                suggestion: 'جرب: 1. زور الموقع يدوياً 2. غير User-Agent 3. استخدم VPN'
            });
        }
        
    } catch (error) {
        console.error('❌ خطأ:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// اختبار الاتصال
app.get('/test-connection', async (req, res) => {
    const testUrl = 'https://azoramoon.com/';
    console.log(`\n🔍 اختبار اتصال بـ ${testUrl}`);
    
    try {
        const response = await axios.get(testUrl, {
            headers: getRandomHeaders(),
            timeout: 10000
        });
        
        res.json({
            success: true,
            status: response.status,
            headers: response.headers,
            dataLength: response.data.length,
            userAgent: getRandomHeaders()['User-Agent']
        });
        
    } catch (error) {
        res.json({
            success: false,
            error: error.message,
            code: error.code,
            userAgent: getRandomHeaders()['User-Agent']
        });
    }
});

// صفحة رئيسية
app.get('/', (req, res) => {
    res.send(`
        <h1>🛡️ البوت 1 - الإصدار المتطور</h1>
        
        <h2>🔗 الروابط:</h2>
        <ul>
            <li><a href="/start-scraping?pages=1">/start-scraping?pages=1</a> - صفحة واحدة</li>
            <li><a href="/start-scraping?pages=2&delay=5">/start-scraping?pages=2&delay=5</a> - صفحتين مع تأخير 5 ثواني</li>
            <li><a href="/test-connection">/test-connection</a> - اختبار الاتصال</li>
        </ul>
        
        <h2>⚙️ الإعدادات:</h2>
        <ul>
            <li>عدد User-Agents: ${USER_AGENTS.length}</li>
            <li>عدد البروكسيات: ${PROXIES.length}</li>
            <li>Firebase: ${DATABASE_SECRETS ? '✅' : '❌'}</li>
        </ul>
        
        <h2>🎯 الميزات:</h2>
        <ul>
            <li>رؤوس عشوائية لكل طلب</li>
            <li>محاولة جميع البروكسيات المجانية</li>
            <li>تأخير ذكي بين الطلبات</li>
            <li>التشغيل على HTTP/HTTPS</li>
        </ul>
    `);
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`\n✅ البوت 1 المتطور يعمل على المنفذ ${PORT}`);
    console.log(`🔗 افتح: https://server-1.onrender.com`);
    console.log(`📱 عدد User-Agents: ${USER_AGENTS.length}`);
    console.log(`🌐 عدد البروكسيات: ${PROXIES.length}`);
});
