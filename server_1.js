const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;

// 🔧 إصلاح: إضافة / للرابط
const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// 🛡️ رؤوس محسنة لتجنب الحظر
const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0'
};

// دالة الكتابة إلى Firebase
async function writeToFirebase(path, data) {
    if (!FIXED_DB_URL || !DATABASE_SECRETS) {
        console.log('⚠️ Firebase غير مهيء');
        return;
    }
    
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    
    try {
        const response = await axios.put(url, data, { timeout: 10000 });
        console.log('✅ تم الحفظ في Firebase');
        return response.data;
    } catch (error) {
        console.error('❌ خطأ في Firebase:', error.message);
        return null;
    }
}

// دالة الجلب مع إعادة محاولة
async function fetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            console.log(`🔄 المحاولة ${i + 1}/${retries} لـ ${url}`);
            
            const response = await axios.get(url, {
                headers: HEADERS,
                timeout: 15000
            });
            
            return response.data;
        } catch (error) {
            console.log(`⚠️ فشل المحاولة ${i + 1}:`, error.message);
            
            if (i < retries - 1) {
                // انتظار متزايد بين المحاولات
                const delay = 2000 * (i + 1);
                console.log(`⏳ انتظار ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw new Error('فشل جميع المحاولات');
}

// دالة لجلب المانجا
async function scrapeMangaFromPage(pageNum) {
    try {
        const url = `https://azoramoon.com/page/${pageNum}/`;
        console.log(`📥 جلب الصفحة: ${url}`);
        
        const html = await fetchWithRetry(url);
        const $ = cheerio.load(html);
        
        const mangaList = [];
        
        // 🔍 البحث بالعديد من الاختيارات المحتملة
        const selectors = [
            '.page-item-detail.manga',
            '.page-item-detail',
            '.manga-item',
            '.item-truyen',
            '.list-truyen .row'
        ];
        
        let foundElements = 0;
        
        for (const selector of selectors) {
            const elements = $(selector);
            if (elements.length > 0) {
                console.log(`✅ وجد ${elements.length} عنصر بـ ${selector}`);
                foundElements = elements.length;
                
                elements.each((i, element) => {
                    const $el = $(element);
                    
                    // محاولات متعددة للعثور على العنوان
                    let title = $el.find('.post-title h3 a').text().trim();
                    if (!title) title = $el.find('h3 a').text().trim();
                    if (!title) title = $el.find('.title a').text().trim();
                    
                    // محاولات متعددة للعثور على الرابط
                    let mangaUrl = $el.find('.post-title h3 a').attr('href');
                    if (!mangaUrl) mangaUrl = $el.find('h3 a').attr('href');
                    if (!mangaUrl) mangaUrl = $el.find('.title a').attr('href');
                    
                    // محاولات للعثور على الصورة
                    let coverUrl = $el.find('.item-thumb img').attr('src');
                    if (!coverUrl) coverUrl = $el.find('img').attr('src');
                    if (!coverUrl) coverUrl = $el.find('img').attr('data-src');
                    
                    // الفصل الأخير
                    let latestChapter = $el.find('.chapter-item .chapter a').text().trim();
                    if (!latestChapter) latestChapter = $el.find('.chapter a').text().trim();
                    if (!latestChapter) latestChapter = $el.find('.chapter-text').text().trim();
                    
                    if (title && mangaUrl) {
                        const mangaId = mangaUrl.split('/series/')[1]?.replace(/[^a-zA-Z0-9]/g, '_') || `manga_${Date.now()}_${i}`;
                        
                        mangaList.push({
                            id: mangaId,
                            title,
                            url: mangaUrl,
                            cover: coverUrl,
                            latestChapter,
                            status: 'pending',
                            addedAt: Date.now()
                        });
                    }
                });
                break;
            }
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
        const { pages = 1 } = req.query;
        console.log(`🚀 بدء جلب ${pages} صفحات...`);
        
        const allManga = [];
        
        for (let page = 1; page <= pages; page++) {
            const manga = await scrapeMangaFromPage(page);
            if (manga.length > 0) {
                allManga.push(...manga);
            }
            
            // تأخير أطول بين الصفحات
            if (page < pages) {
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        
        console.log(`✅ تم جمع ${allManga.length} مانجا`);
        
        // حفظ في Firebase
        if (allManga.length > 0) {
            for (const manga of allManga) {
                // حفظ المانجا الرئيسية
                await writeToFirebase(`HomeManga/${manga.id}`, {
                    title: manga.title,
                    url: manga.url,
                    cover: manga.cover,
                    latestChapter: manga.latestChapter,
                    status: 'pending_chapters',
                    scrapedAt: Date.now()
                });
                
                // إنشاء مهمة
                await writeToFirebase(`Jobs/${manga.id}`, {
                    mangaUrl: manga.url,
                    status: 'waiting',
                    createdAt: Date.now()
                });
                
                console.log(`💾 تم حفظ: ${manga.title}`);
            }
            
            res.json({
                success: true,
                message: `تم جلب ${allManga.length} مانجا وحفظها`,
                mangaCount: allManga.length,
                mangas: allManga.map(m => ({ title: m.title, id: m.id }))
            });
        } else {
            // 🔍 اختبار مباشر للموقع
            const testUrl = 'https://azoramoon.com/';
            console.log(`🔍 اختبار مباشر للموقع: ${testUrl}`);
            
            try {
                const testResponse = await axios.get(testUrl, { headers: HEADERS, timeout: 10000 });
                console.log(`✅ الموقع يستجيب، الحالة: ${testResponse.status}`);
                console.log(`📏 طول HTML: ${testResponse.data.length} حرف`);
                
                // تحليل سريع
                const $ = cheerio.load(testResponse.data);
                const pageTitle = $('title').text();
                console.log(`🏷️ عنوان الصفحة: ${pageTitle}`);
                
                // عد العناصر المحتملة
                const mangaElements = $('.page-item-detail.manga').length;
                console.log(`🔢 عناصر مانجا محتملة: ${mangaElements}`);
                
            } catch (testError) {
                console.error(`❌ اختبار الموقع فشل:`, testError.message);
            }
            
            res.json({
                success: false,
                message: 'لم يتم العثور على أي مانجا',
                test: 'جرب زيارة الموقع يدوياً للتحقق'
            });
        }
        
    } catch (error) {
        console.error('❌ خطأ:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            tip: 'قد يكون الموقع يحجب طلبات Render. جرب إضافة Cloudflare أو تغيير User-Agent'
        });
    }
});

// صفحة رئيسية
app.get('/', (req, res) => {
    res.send(`
        <h1>✅ البوت 1 يعمل</h1>
        <p><a href="/start-scraping?pages=1">/start-scraping?pages=1</a> - لجلب صفحة واحدة</p>
        <p><a href="/start-scraping?pages=3">/start-scraping?pages=3</a> - لجلب 3 صفحات</p>
        <p>Firebase: ${DATABASE_SECRETS ? '✅ مهيء' : '❌ غير مهيء'}</p>
        <p>Database URL: ${FIXED_DB_URL || '❌ غير محدد'}</p>
    `);
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`✅ البوت 1 يعمل على المنفذ ${PORT}`);
    console.log(`🔗 Firebase: ${FIXED_DB_URL ? '✅' : '❌'}`);
    console.log(`🔗 Secrets: ${DATABASE_SECRETS ? '✅' : '❌'}`);
});
