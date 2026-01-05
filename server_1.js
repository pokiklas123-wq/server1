const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
require('dotenv').config();

// ==================== متغيرات البيئة ====================
const PORT = process.env.PORT || 10000;
const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;
const SERVER_2_URL = process.env.SERVER_2_URL; // متغير بيئة جديد للاتصال بالبوت 2

const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// ==================== دوال Firebase ====================
// (يجب أن تكون هذه الدوال موجودة في ملف منفصل أو مضمنة هنا)
// لغرض التعديل، سنفترض وجودها كما في الكود الأصلي
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
            return null; // لا يوجد بيانات
        }
        console.error(`❌ فشل القراءة من Firebase في ${path}:`, error.message);
        throw error;
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
    '', // بدون بروكسي أولاً
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
            
            console.log(`🔄 محاولة [${proxy ? 'بروكسي' : 'مباشر'}]: ${targetUrl.substring(0, 80)}...`);
            
            const response = await axios.get(targetUrl, {
                headers: getRandomHeaders(),
                timeout: 20000,
                maxRedirects: 3,
                validateStatus: (status) => status >= 200 && status < 500
            });
            
            if (response.status === 200) {
                console.log(`✅ نجح [${proxy ? 'بروكسي' : 'مباشر'}]: ${response.status}`);
                return response.data;
            } else {
                errors.push(`${proxy ? 'بروكسي' : 'مباشر'}: ${response.status}`);
            }
            
        } catch (error) {
            errors.push(`${proxy ? 'بروكسي' : 'مباشر'}: ${error.message}`);
            console.log(`❌ فشل [${proxy ? 'بروكسي' : 'مباشر'}]: ${error.message}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000)); // تأخير بسيط
    }
    
    throw new Error(`فشلت جميع محاولات الجلب:\n${errors.join('\n')}`);
}

// ==================== منطق الاستخراج ====================

function extractManga(html, pageNum) {
    const $ = cheerio.load(html);
    const mangaList = [];
    const selectors = [
        '.c-tabs-item__content .tab-content-area .row .col-sm-6', // الأكثر شيوعاً
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
            console.log(`✅ وجد ${foundCount} مانجا بـ "${selector}"`);

            elements.each((i, element) => {
                const $el = $(element);
                
                // الرابط والعنوان
                let mangaUrl = $el.find('.post-title a').attr('href');
                let title = $el.find('.post-title a').text().trim();
                
                if (!mangaUrl) mangaUrl = $el.find('a').first().attr('href');
                if (!title) title = $el.find('a').first().text().trim();

                // الغلاف
                let coverUrl = $el.find('.item-thumb img').attr('src') || $el.find('.item-thumb img').attr('data-src');
                if (!coverUrl) coverUrl = $el.find('img').attr('src') || $el.find('img').attr('data-src');
                if (!coverUrl && mangaUrl) {
                    coverUrl = 'https://via.placeholder.com/175x238?text=No+Cover';
                }
                
                // الفصل الأخير
                let latestChapter = $el.find('.chapter-item .chapter a').text().trim() || $el.find('.chapter a').text().trim() || $el.find('.chapter-text').text().trim() || 'غير معروف';
                
                if (title && mangaUrl) {
                    const mangaId = crypto.createHash('md5').update(mangaUrl).digest('hex').substring(0, 12);
                    
                    mangaList.push({
                        id: mangaId,
                        title,
                        url: mangaUrl,
                        cover: coverUrl,
                        latestChapter,
                        status: 'pending_chapters', // الحالة الأولية
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
    if (!SERVER_2_URL) {
        console.log('⚠️ لم يتم تحديد SERVER_2_URL. لن يتم إخطار البوت 2.');
        return;
    }
    
    const url = `${SERVER_2_URL}/process-manga/${mangaId}`;
    console.log(`\n🔔 إخطار البوت 2 لبدء معالجة المانجا: ${mangaId}`);
    
    try {
        const response = await axios.get(url, { timeout: 10000 });
        console.log(`✅ استجابة البوت 2: ${response.data.message || 'تم الإخطار بنجاح'}`);
    } catch (error) {
        console.error(`❌ فشل إخطار البوت 2: ${error.message}`);
    }
}

async function startContinuousScraping(startPage = 1) {
    let page = startPage;
    let totalMangaCount = 0;
    let newMangaCount = 0;
    const MAX_PAGES = 100; // حد أقصى لعدد الصفحات لتجنب الحلقات اللانهائية

    console.log(`\n🚀 بدء الجلب المستمر من الصفحة ${startPage}...`);

    while (page <= MAX_PAGES) {
        const url = `https://azoramoon.com/page/${page}/?m_orderby=latest`;
        console.log(`\n📄 جلب الصفحة ${page}: ${url}`);
        
        try {
            const html = await tryAllProxies(url);
            const mangaOnPage = extractManga(html, page);

            if (mangaOnPage.length === 0) {
                console.log(`⚠️ الصفحة ${page} لا تحتوي على مانجا. إنهاء الجلب.`);
                break;
            }

            let pageNewManga = 0;
            for (const manga of mangaOnPage) {
                const existingManga = await readFromFirebase(`HomeManga/${manga.id}`);
                
                if (!existingManga) {
                    // مانجا جديدة
                    await writeToFirebase(`HomeManga/${manga.id}`, manga);
                    await writeToFirebase(`Jobs/${manga.id}`, {
                        mangaUrl: manga.url,
                        status: 'waiting_chapters',
                        createdAt: Date.now(),
                        title: manga.title
                    });
                    console.log(`✨ مانجا جديدة: ${manga.title}`);
                    pageNewManga++;
                    newMangaCount++;
                    
                    // إخطار البوت 2 لمعالجة الفصول
                    await notifyServer2(manga.id);
                    
                } else if (existingManga.latestChapter !== manga.latestChapter) {
                    // تحديث فصل جديد
                    await writeToFirebase(`HomeManga/${manga.id}`, {
                        ...existingManga,
                        latestChapter: manga.latestChapter,
                        updatedAt: Date.now()
                    });
                    
                    // تحديث حالة المهمة لإعادة المعالجة
                    await writeToFirebase(`Jobs/${manga.id}`, {
                        mangaUrl: manga.url,
                        status: 'waiting_chapters',
                        createdAt: Date.now(),
                        title: manga.title
                    });
                    console.log(`🔄 تحديث فصل لـ: ${manga.title} - الفصل الأخير: ${manga.latestChapter}`);
                    pageNewManga++;
                    newMangaCount++;
                    
                    // إخطار البوت 2 لمعالجة الفصول
                    await notifyServer2(manga.id);
                }
            }
            
            totalMangaCount += mangaOnPage.length;
            console.log(`✅ الصفحة ${page} تمت. تم العثور على ${mangaOnPage.length} مانجا، منها ${pageNewManga} جديدة/محدثة.`);

            // إذا لم يتم العثور على أي مانجا جديدة/محدثة في الصفحة الأولى، يمكن التوقف
            if (page === 1 && pageNewManga === 0) {
                console.log('ℹ️ لم يتم العثور على مانجا جديدة/محدثة في الصفحة الأولى. إنهاء الجلب للصفحات العميقة.');
                break;
            }
            
            page++;
            
            // تأخير بين الصفحات
            const waitTime = 5000; // 5 ثواني
            console.log(`⏳ انتظار ${waitTime / 1000} ثواني قبل الصفحة التالية...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));

        } catch (error) {
            console.error(`❌ خطأ في جلب الصفحة ${page}:`, error.message);
            // في حالة الخطأ، ننتظر ونحاول الصفحة التالية (أو ننهي إذا كان الخطأ متكرراً)
            page++;
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }
    
    console.log(`\n🏁 انتهى الجلب المستمر. إجمالي المانجا التي تم فحصها: ${totalMangaCount}. مانجا جديدة/محدثة: ${newMangaCount}.`);
    return { totalMangaCount, newMangaCount };
}

// ==================== واجهات API ====================
const app = express();

// 🎯 API للبدء (نقطة الدخول الرئيسية)
app.get('/start-scraping', async (req, res) => {
    try {
        const { totalMangaCount, newMangaCount } = await startContinuousScraping(1);
        
        res.json({
            success: true,
            message: 'تم إنهاء عملية الجلب المستمر.',
            details: {
                totalMangaChecked: totalMangaCount,
                newOrUpdatedManga: newMangaCount,
                nextAction: 'البوت 2 سيبدأ معالجة الفصول الجديدة/المحدثة تلقائياً.'
            }
        });
        
    } catch (error) {
        console.error('❌ خطأ في /start-scraping:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            message: 'فشل في عملية الجلب المستمر.'
        });
    }
});

// 🏠 الصفحة الرئيسية المبسطة
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html dir="rtl" lang="ar">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>🛡️ البوت 1 - جالب المانجا</title>
            <style>
                body { font-family: 'Arial', sans-serif; margin: 20px; background: #f5f5f5; text-align: right; }
                .container { max-width: 600px; margin: 0 auto; background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                h1 { color: #333; border-bottom: 3px solid #4CAF50; padding-bottom: 10px; }
                ul { list-style: none; padding: 0; }
                li { margin: 10px 0; padding: 10px; background: #f9f9f9; border-radius: 5px; border-right: 4px solid #4CAF50; }
                a { color: #2196F3; text-decoration: none; font-weight: bold; }
                a:hover { text-decoration: underline; }
                .status { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 0.9em; }
                .success { background: #d4edda; color: #155724; }
                .error { background: #f8d7da; color: #721c24; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🛡️ البوت 1 - جالب المانجا</h1>
                
                <h2>⚙️ حالة النظام:</h2>
                <ul>
                    <li>Firebase: <span class="status ${DATABASE_SECRETS ? 'success' : 'error'}">${DATABASE_SECRETS ? '✅ متصل' : '❌ غير متصل'}</span></li>
                    <li>البوت 2 URL: <span class="status ${SERVER_2_URL ? 'success' : 'error'}">${SERVER_2_URL ? '✅ محدد' : '❌ مفقود'}</span></li>
                    <li>المنفذ: <span class="status success">${PORT}</span></li>
                </ul>
                
                <h2>🎯 الروابط الرئيسية:</h2>
                <ul>
                    <li><a href="/start-scraping">/start-scraping</a> - بدء الجلب المستمر (يجب أن يتم استدعاؤه بواسطة Render Cron Job)</li>
                </ul>
                
                <h2>📝 ملاحظة:</h2>
                <p>هذا البوت يعمل بشكل آلي. يجب إعداد Render Cron Job لاستدعاء <code>/start-scraping</code> بشكل دوري (مثلاً كل ساعة) لمراقبة المانجا الجديدة والفصول المحدثة.</p>
            </div>
        </body>
        </html>
    `);
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`\n✅ البوت 1 (جالب المانجا) يعمل على المنفذ ${PORT}`);
    console.log(`🎯 جاهز لبدء الجلب...`);
});
