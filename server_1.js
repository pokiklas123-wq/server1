const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;

const FIXED_DB_URL = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;

// 🔧 الدوال الأساسية
async function writeToFirebase(path, data) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try {
        await axios.put(url, data, { timeout: 5000 });
        console.log(`✅ كتب: ${path}`);
        return true;
    } catch (error) {
        console.error(`❌ Firebase: ${error.message}`);
        return false;
    }
}

async function readFromFirebase(path) {
    const url = `${FIXED_DB_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    try {
        const response = await axios.get(url, { timeout: 5000 });
        return response.data;
    } catch (error) {
        console.error(`❌ قراءة: ${error.message}`);
        return null;
    }
}

// 🎯 استخراج المانجا من الصفحة
async function extractMangaFromPage(pageNum) {
    try {
        const url = `https://azoramoon.com/page/${pageNum}/`;
        console.log(`📥 صفحة ${pageNum}: ${url}`);
        
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 10000
        });
        
        const $ = cheerio.load(response.data);
        const mangaList = [];
        
        $('.page-item-detail.manga').each((i, element) => {
            const $el = $(element);
            const title = $el.find('.post-title h3 a').text().trim();
            const mangaUrl = $el.find('.post-title h3 a').attr('href');
            const coverUrl = $el.find('.item-thumb img').attr('src');
            const latestChapter = $el.find('.chapter-item .chapter a').text().trim();
            
            if (title && mangaUrl) {
                const mangaId = crypto.createHash('md5').update(mangaUrl).digest('hex').substring(0, 12);
                
                mangaList.push({
                    id: mangaId,
                    title,
                    url: mangaUrl,
                    cover: coverUrl,
                    latestChapter,
                    page: pageNum,
                    foundAt: Date.now()
                });
            }
        });
        
        console.log(`📊 صفحة ${pageNum}: ${mangaList.length} مانجا`);
        return mangaList;
        
    } catch (error) {
        console.error(`❌ صفحة ${pageNum}: ${error.message}`);
        return [];
    }
}

// 🔄 المعالجة التلقائية
async function autoScrape() {
    console.log('\n🔄 بدء المسح التلقائي...');
    
    try {
        // صفحة واحدة فقط (الأولى)
        const mangaList = await extractMangaFromPage(1);
        
        if (mangaList.length === 0) {
            console.log('⚠️ لم يتم العثور على مانجا');
            return;
        }
        
        let newMangaCount = 0;
        let updatedMangaCount = 0;
        
        for (const manga of mangaList) {
            // التحقق إذا كانت المانجا موجودة
            const existingManga = await readFromFirebase(`HomeManga/${manga.id}`);
            
            if (!existingManga) {
                // مانجا جديدة
                await writeToFirebase(`HomeManga/${manga.id}`, {
                    title: manga.title,
                    url: manga.url,
                    cover: manga.cover,
                    latestChapter: manga.latestChapter,
                    status: 'pending_chapters',
                    firstSeen: Date.now(),
                    lastChecked: Date.now()
                });
                
                // إنشاء مهمة للبوت 2
                await writeToFirebase(`Jobs/${manga.id}`, {
                    mangaUrl: manga.url,
                    title: manga.title,
                    status: 'waiting',
                    createdAt: Date.now()
                });
                
                console.log(`➕ مانجا جديدة: ${manga.title}`);
                newMangaCount++;
                
            } else {
                // تحديث الفصل الأخير
                if (existingManga.latestChapter !== manga.latestChapter) {
                    await writeToFirebase(`HomeManga/${manga.id}/latestChapter`, manga.latestChapter);
                    await writeToFirebase(`HomeManga/${manga.id}/lastChecked`, Date.now());
                    
                    // التحقق من فصول جديدة
                    await checkForNewChapters(manga.id, existingManga);
                    
                    console.log(`🔄 تم تحديث: ${manga.title}`);
                    updatedMangaCount++;
                }
            }
        }
        
        console.log(`📊 النتيجة: ${newMangaCount} جديدة, ${updatedMangaCount} محدثة`);
        
    } catch (error) {
        console.error('❌ خطأ في المسح:', error.message);
    }
}

// 🔍 التحقق من فصول جديدة
async function checkForNewChapters(mangaId, mangaData) {
    try {
        console.log(`🔍 التحقق من فصول جديدة لـ ${mangaId}`);
        
        // قراءة الفصول الحالية
        const existingChapters = await readFromFirebase(`ImgChapter/${mangaId}`);
        const currentChapters = existingChapters ? Object.keys(existingChapters).length : 0;
        
        // إضافة علامة للمعالجة
        await writeToFirebase(`HomeManga/${mangaId}/needsChapterCheck`, true);
        await writeToFirebase(`HomeManga/${mangaId}/lastChapterCheck`, Date.now());
        
        console.log(`📝 تم وضع علامة للفحص (${currentChapters} فصل حالياً)`);
        
    } catch (error) {
        console.error(`❌ خطأ في فحص الفصول: ${error.message}`);
    }
}

// 🏃‍♂️ تشغيل تلقائي كل 5 دقائق
let autoScrapeInterval = null;

function startAutoScrape(intervalMinutes = 5) {
    if (autoScrapeInterval) {
        clearInterval(autoScrapeInterval);
    }
    
    const intervalMs = intervalMinutes * 60 * 1000;
    autoScrapeInterval = setInterval(autoScrape, intervalMs);
    
    console.log(`⏰ تم ضبط المسح التلقائي كل ${intervalMinutes} دقيقة`);
    
    // تشغيل أول مرة مباشرة
    setTimeout(autoScrape, 5000);
}

// 🛑 إيقاف المسح التلقائي
function stopAutoScrape() {
    if (autoScrapeInterval) {
        clearInterval(autoScrapeInterval);
        autoScrapeInterval = null;
        console.log('⏹️ توقف المسح التلقائي');
    }
}

// 📊 API للتحكم
app.get('/start-auto', (req, res) => {
    const interval = parseInt(req.query.minutes) || 5;
    startAutoScrape(interval);
    res.json({ success: true, message: `بدأ المسح كل ${interval} دقيقة` });
});

app.get('/stop-auto', (req, res) => {
    stopAutoScrape();
    res.json({ success: true, message: 'توقف المسح التلقائي' });
});

app.get('/run-now', async (req, res) => {
    await autoScrape();
    res.json({ success: true, message: 'تم المسح الآن' });
});

app.get('/status', async (req, res) => {
    const stats = await readFromFirebase('HomeManga') || {};
    const jobs = await readFromFirebase('Jobs') || {};
    
    const totalManga = Object.keys(stats).length;
    const pendingJobs = Object.values(jobs).filter(j => j.status === 'waiting').length;
    
    res.json({
        success: true,
        autoRunning: !!autoScrapeInterval,
        totalManga,
        pendingJobs,
        sample: Object.keys(stats).slice(0, 3)
    });
});

// 🏠 صفحة بسيطة
app.get('/', (req, res) => {
    res.send(`
        <h1>📚 البوت 1 - المسح التلقائي</h1>
        <p><a href="/start-auto">/start-auto</a> - بدء التلقائي (5 دقائق)</p>
        <p><a href="/stop-auto">/stop-auto</a> - إيقاف التلقائي</p>
        <p><a href="/run-now">/run-now</a> - تشغيل الآن</p>
        <p><a href="/status">/status</a> - حالة النظام</p>
        <p>📈 النظام: ${autoScrapeInterval ? '🟢 يعمل' : '🔴 متوقف'}</p>
    `);
});

// 🚀 التشغيل
app.listen(PORT, () => {
    console.log(`✅ البوت 1 يعمل على ${PORT}`);
    console.log(`🔗 http://localhost:${PORT}`);
    
    // بدء تلقائي عند التشغيل
    startAutoScrape(5);
});
