const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./shared-db');
const crypto = require('crypto');
const app = express();
const PORT = process.env.PORT || 3000;

// 🔧 إعدادات النظام
const MONITOR_INTERVAL = 5 * 60 * 1000; // كل 5 دقائق
const PROCESS_DELAY = 2000; // تأخير بين الصفحات
let isProcessing = false;
let currentPage = 1;
let totalMangasProcessed = 0;

// 📱 قائمة User-Agents
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
];

// 🌐 قائمة بروكسيات
const PROXIES = [
    '', // بدون بروكسي
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url='
];

// 🎯 دالة جلب الصفحة مع إعادة المحاولة
async function fetchWithRetry(url, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        const proxy = PROXIES[Math.floor(Math.random() * PROXIES.length)];
        
        try {
            let targetUrl = url;
            if (proxy) {
                targetUrl = proxy + encodeURIComponent(url);
            }
            
            console.log(`🔄 المحاولة ${attempt}/${retries} ${proxy ? 'مع بروكسي' : 'بدون بروكسي'}`);
            
            const response = await axios.get(targetUrl, {
                headers: {
                    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Referer': 'https://azoramoon.com/'
                },
                timeout: 15000
            });
            
            if (response.status === 200) {
                return response.data;
            }
        } catch (error) {
            console.log(`❌ فشل المحاولة ${attempt}:`, error.message);
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
            }
        }
    }
    throw new Error(`فشل جلب ${url} بعد ${retries} محاولات`);
}

// 📖 دالة استخراج المانجا من الصفحة
async function scrapeMangaPage(pageNum) {
    const url = `https://azoramoon.com/page/${pageNum}/`;
    console.log(`\n📄 جلب الصفحة ${pageNum}: ${url}`);
    
    try {
        const html = await fetchWithRetry(url);
        const $ = cheerio.load(html);
        const mangas = [];
        
        // 🔍 البحث عن عناصر المانجا
        const selectors = [
            '.page-item-detail.manga',
            '.page-item-detail',
            '.manga-item',
            '.col-xs-12.col-sm-6.col-md-4',
            '.manga-entry'
        ];
        
        let foundSelector = '';
        let elements = null;
        
        for (const selector of selectors) {
            elements = $(selector);
            if (elements.length > 0) {
                foundSelector = selector;
                console.log(`✅ وجد ${elements.length} مانجا بـ "${selector}"`);
                break;
            }
        }
        
        if (!elements || elements.length === 0) {
            console.log('❌ لم أجد أي مانجا في الصفحة');
            return { success: false, mangas: [] };
        }
        
        // استخراج بيانات المانجا
        elements.each((i, element) => {
            const $el = $(element);
            
            // استخراج العنوان
            const title = $el.find('.post-title h3 a').text().trim() ||
                         $el.find('h3 a').text().trim() ||
                         $el.find('.title a').text().trim() ||
                         $el.find('a').first().text().trim();
            
            // استخراج الرابط
            let mangaUrl = $el.find('.post-title h3 a').attr('href') ||
                          $el.find('h3 a').attr('href') ||
                          $el.find('.title a').attr('href') ||
                          $el.find('a').first().attr('href');
            
            // استخراج الصورة
            let coverUrl = $el.find('img').attr('src') ||
                          $el.find('img').attr('data-src');
            
            // إصلاح الروابط النسبية
            if (mangaUrl && !mangaUrl.startsWith('http')) {
                mangaUrl = 'https://azoramoon.com' + (mangaUrl.startsWith('/') ? '' : '/') + mangaUrl;
            }
            
            if (coverUrl && !coverUrl.startsWith('http')) {
                coverUrl = 'https://azoramoon.com' + (coverUrl.startsWith('/') ? '' : '/') + coverUrl;
            }
            
            if (title && mangaUrl) {
                const mangaId = crypto.createHash('md5').update(mangaUrl).digest('hex').substring(0, 12);
                
                mangas.push({
                    id: mangaId,
                    title: title.trim(),
                    url: mangaUrl.trim(),
                    cover: coverUrl ? coverUrl.trim() : 'https://via.placeholder.com/175x238?text=No+Cover',
                    page: pageNum,
                    selector: foundSelector,
                    scrapedAt: Date.now()
                });
            }
        });
        
        console.log(`✅ تم استخراج ${mangas.length} مانجا من الصفحة ${pageNum}`);
        return { success: true, mangas };
        
    } catch (error) {
        console.error(`❌ خطأ في الصفحة ${pageNum}:`, error.message);
        return { success: false, mangas: [], error: error.message };
    }
}

// 💾 دالة حفظ المانجا في قاعدة البيانات
async function saveMangaToDatabase(manga) {
    try {
        // التحقق مما إذا كانت المانجا موجودة مسبقاً
        const existing = await db.read(`HomeManga/${manga.id}`);
        
        if (existing) {
            // تحديث المانجا الموجودة
            await db.write(`HomeManga/${manga.id}`, {
                ...existing,
                ...manga,
                updatedAt: Date.now()
            });
            
            // التحقق من وجود فصول جديدة
            const status = await db.read(`status/${manga.id}`);
            if (status && status.status === 'completed') {
                await db.updateStatus(manga.id, null, 'needs_update', {
                    title: manga.title,
                    lastChecked: Date.now()
                });
            }
            
            console.log(`↻ تم تحديث مانجا موجودة: ${manga.title}`);
            return 'updated';
        } else {
            // حفظ مانجا جديدة
            await db.write(`HomeManga/${manga.id}`, {
                title: manga.title,
                url: manga.url,
                cover: manga.cover,
                status: 'pending_chapters',
                addedAt: Date.now(),
                page: manga.page
            });
            
            // إنشاء حالة المانجا
            await db.updateStatus(manga.id, null, 'pending_chapters', {
                title: manga.title,
                url: manga.url,
                page: manga.page,
                addedAt: Date.now()
            });
            
            // إنشاء مهمة
            await db.write(`Jobs/${manga.id}`, {
                mangaId: manga.id,
                mangaUrl: manga.url,
                title: manga.title,
                status: 'pending',
                createdAt: Date.now()
            });
            
            console.log(`✅ تم إضافة مانجا جديدة: ${manga.title}`);
            totalMangasProcessed++;
            return 'added';
        }
    } catch (error) {
        console.error(`❌ خطأ في حفظ ${manga.title}:`, error.message);
        return 'error';
    }
}

// 🔄 دالة معالجة جميع الصفحات
async function scrapeAllPages(startPage = 1) {
    if (isProcessing) {
        console.log('⚠️ السيرفر مشغول حالياً');
        return;
    }
    
    isProcessing = true;
    let page = startPage;
    let hasMorePages = true;
    let pagesProcessed = 0;
    
    console.log(`\n🚀 بدء جلب جميع صفحات المانجا من الصفحة ${startPage}...`);
    
    try {
        while (hasMorePages) {
            console.log(`\n📖 معالجة الصفحة ${page}...`);
            
            const result = await scrapeMangaPage(page);
            
            if (result.success && result.mangas.length > 0) {
                // معالجة كل مانجا في الصفحة
                for (const manga of result.mangas) {
                    await saveMangaToDatabase(manga);
                    
                    // تأخير بين المانجا
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                
                pagesProcessed++;
                currentPage = page;
                page++;
                
                // تأخير بين الصفحات
                console.log(`⏳ انتظار ${PROCESS_DELAY/1000} ثواني للصفحة التالية...`);
                await new Promise(resolve => setTimeout(resolve, PROCESS_DELAY));
                
            } else {
                // لا توجد مانجا في الصفحة، توقف
                hasMorePages = false;
                console.log(`⏹️ توقف عند الصفحة ${page} (لا توجد مانجا)`);
                
                // العودة للصفحة 1
                currentPage = 1;
            }
        }
        
        console.log(`\n✅ اكتمل جلب الصفحات!`);
        console.log(`📊 النتائج:`);
        console.log(`   - الصفحات المعالجة: ${pagesProcessed}`);
        console.log(`   - إجمالي المانجا: ${totalMangasProcessed}`);
        
    } catch (error) {
        console.error('❌ خطأ في معالجة الصفحات:', error.message);
    } finally {
        isProcessing = false;
    }
}

// 👁️ دالة مراقبة الصفحة الأولى
async function monitorFirstPage() {
    if (isProcessing) return;
    
    console.log('\n👁️ فحص الصفحة الأولى للبحث عن مانجا جديدة...');
    
    const result = await scrapeMangaPage(1);
    if (result.success) {
        let newCount = 0;
        let updatedCount = 0;
        
        for (const manga of result.mangas) {
            const status = await saveMangaToDatabase(manga);
            
            if (status === 'added') newCount++;
            if (status === 'updated') updatedCount++;
            
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        
        if (newCount > 0 || updatedCount > 0) {
            console.log(`📈 تم تحديث الصفحة الأولى:`);
            console.log(`   - جديد: ${newCount} مانجا`);
            console.log(`   - محدث: ${updatedCount} مانجا`);
        }
    }
}

// ⏰ دالة التشغيل التلقائي
async function startAutoScraping() {
    console.log('\n🤖 بدء التشغيل التلقائي...');
    
    // بدء جلب جميع الصفحات
    await scrapeAllPages(currentPage);
    
    // بعد الانتهاء، ابدأ المراقبة الدورية
    setInterval(monitorFirstPage, MONITOR_INTERVAL);
    
    console.log(`🔔 سيتم فحص الصفحة الأولى كل ${MONITOR_INTERVAL/60000} دقيقة`);
}

// 📡 API Routes
app.get('/', (req, res) => {
    res.json({
        server: 'Server 1 - Auto Manga Scraper',
        status: isProcessing ? 'معالجة...' : 'جاهز',
        stats: {
            currentPage,
            totalMangasProcessed,
            isProcessing,
            nextCheck: new Date(Date.now() + MONITOR_INTERVAL).toLocaleString('ar-SA')
        },
        endpoints: [
            '/start - بدء الجلب التلقائي',
            '/scrape-page/:page - جلب صفحة محددة',
            '/monitor - فحص الصفحة الأولى',
            '/status - حالة النظام'
        ]
    });
});

app.get('/start', async (req, res) => {
    if (isProcessing) {
        return res.json({ message: 'النظام يعمل حالياً' });
    }
    
    res.json({ 
        message: 'بدأ الجلب التلقائي للصفحات',
        currentPage,
        estimatedTime: 'يستغرق بضع دقائق'
    });
    
    startAutoScraping();
});

app.get('/scrape-page/:page', async (req, res) => {
    const pageNum = parseInt(req.params.page) || 1;
    
    try {
        const result = await scrapeMangaPage(pageNum);
        
        if (result.success) {
            let addedCount = 0;
            for (const manga of result.mangas) {
                const status = await saveMangaToDatabase(manga);
                if (status === 'added') addedCount++;
            }
            
            res.json({
                success: true,
                page: pageNum,
                mangasFound: result.mangas.length,
                added: addedCount,
                sample: result.mangas.slice(0, 3)
            });
        } else {
            res.json({
                success: false,
                page: pageNum,
                error: result.error
            });
        }
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/monitor', async (req, res) => {
    await monitorFirstPage();
    res.json({ 
        message: 'تم فحص الصفحة الأولى',
        currentPage,
        totalMangasProcessed
    });
});

app.get('/status', (req, res) => {
    res.json({
        isProcessing,
        currentPage,
        totalMangasProcessed,
        nextMonitor: new Date(Date.now() + MONITOR_INTERVAL).toISOString(),
        userAgentsCount: USER_AGENTS.length,
        proxiesCount: PROXIES.length
    });
});

// 🚀 تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`\n✅ السيرفر 1 يعمل على المنفذ ${PORT}`);
    console.log('🎯 جاهز لاستخراج المانجا من جميع الصفحات');
    console.log('🤖 سيبدأ العمل تلقائياً خلال 10 ثواني...');
    
    // بدء العمل بعد 10 ثواني
    setTimeout(() => {
        startAutoScraping();
    }, 10000);
});
