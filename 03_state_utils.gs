function setWithTTL(key, value, min, useCache = false) {
  const ttlMs = Date.now() + min * 60000;

  if (useCache && min <= 120) { // CacheService для короткоживущих данных (до 2 часов)
    try {
      const cacheKey = `cache_${key}`;
      CACHE.put(cacheKey, JSON.stringify(value), min * 60);
      // Дублируем в ScriptProperties для резерва
      scriptProps.setProperty(key, JSON.stringify(value));
      scriptProps.setProperty(`ttl_${key}`, String(ttlMs));
    } catch (e) {
      // Fallback на ScriptProperties
      console.warn(`CacheService failed for ${key}, using ScriptProperties`);
      scriptProps.setProperty(key, JSON.stringify(value));
      scriptProps.setProperty(`ttl_${key}`, String(ttlMs));
    }
  } else {
    // ScriptProperties для долгоживущих данных
    scriptProps.setProperty(key, JSON.stringify(value));
    scriptProps.setProperty(`ttl_${key}`, String(ttlMs));
  }
}

// 🔥 ОБНОВЛЕННЫЙ getWithTTL С ПРОВЕРКОЙ TTL ДЛЯ CACHE
function getWithTTL(key) {
  // 1. Проверяем TTL в ScriptProperties (главный источник истины)
  const ttl = scriptProps.getProperty(`ttl_${key}`);
  const val = scriptProps.getProperty(key);

  // Если TTL истек - удаляем ВСЕ следы и возвращаем null
  if (ttl && Date.now() > Number(ttl)) {
    scriptProps.deleteProperty(key);
    scriptProps.deleteProperty(`ttl_${key}`);

    try {
      CACHE.remove(`cache_${key}`);
      CACHE.remove(key);
    } catch (e) {
      // Игнорируем ошибки CacheService
    }

    return null;
  }

  // Если TTL/данные в Properties уже удалены, не даем CacheService вернуть устаревшее значение
  if (!ttl && !val) {
    try {
      CACHE.remove(`cache_${key}`);
      CACHE.remove(key);
    } catch (e) {
      // Игнорируем ошибки CacheService
    }
    return null;
  }

  // 2. Пробуем CacheService, но только если TTL актуален
  try {
    const cacheKeys = [`cache_${key}`, key];
    for (const cacheKey of cacheKeys) {
      const cached = CACHE.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }
  } catch (e) {
    // Игнорируем ошибки CacheService
  }

  // 3. Fallback на ScriptProperties
  return val ? JSON.parse(val) : null;
}

// 🔥 УЛУЧШЕННАЯ ОЧИСТКА СТАРЫХ СВОЙСТВ
function cleanupOldProperties() {
  const allProps = scriptProps.getProperties();
  const now = Date.now();
  let deletedCount = 0;
  let errorCount = 0;

  console.log(`🧹 Начинаю очистку свойств. Всего ключей: ${Object.keys(allProps).length}`);

  for (const key in allProps) {
    if (key.startsWith('ttl_')) {
      try {
        const ttl = Number(allProps[key]);
        if (ttl && now > ttl) {
          const dataKey = key.replace('ttl_', '');

          // 🔥 УДАЛЯЕМ ОСНОВНОЙ КЛЮЧ И TTL
          scriptProps.deleteProperty(dataKey);
          scriptProps.deleteProperty(key);

          // 🔥 УДАЛЯЕМ ИЗ CACHESERVICE
          try {
            CACHE.remove(`cache_${dataKey}`);
          } catch (e) {
            // Игнорируем ошибки CacheService
          }

          deletedCount++;

          // 🔥 ЛОГИРОВАНИЕ КАЖДЫЕ 50 КЛЮЧЕЙ
          if (deletedCount % 50 === 0) {
            console.log(`🧹 Очищено ${deletedCount} ключей...`);
          }
        }
      } catch (error) {
        console.error(`❌ Ошибка при обработке ключа ${key}:`, error);
        errorCount++;
      }
    }
  }

  console.log(`🧹 Очистка свойств завершена: удалено ${deletedCount} ключей, ошибок: ${errorCount}`);

  // 🔥 УВЕДОМЛЕНИЕ В ТЕЛЕГРАМ (только в DEBUG)
  if (CONFIG.DEBUG && deletedCount > 0) {
    const msg = `🧹 Очистка старых свойств завершена\n` +
               `Удалено ключей: ${deletedCount}\n` +
               `Ошибок: ${errorCount}\n` +
               `Осталось ключей: ${Object.keys(scriptProps.getProperties()).length}`;

    sendMessage(msg, null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST, null, { markdown: false });
  }

  return { deleted: deletedCount, errors: errorCount, remaining: Object.keys(scriptProps.getProperties()).length };
}

function mdSafe(text) {
  if (text === null || text === undefined) return '';
  const str = String(text);
  return str.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// Возвращаем число как число, чтобы Sheets мог считать суммы
function formatNumber(num) {
  if (num === '' || num === null || isNaN(num)) return '';
  return Number(num);
}

function formatPriceForDisplay(num) {
  if (num === '' || num === null || num === undefined) return '0,00';
  // Если это строка, то преобразуем в число, используя parsePrice
  const number = typeof num === 'string' ? parsePrice(num) : Number(num);
  if (isNaN(number)) return '0,00';
  // Форматируем с двумя знаками после запятой
  return number.toFixed(2).replace('.', ',');
}


function parsePrice(text) {
  if (typeof text === 'number') return text;
  const clean = String(text || '').replace(',', '.').replace(/[^\d.]/g, '');
  return Number(clean) || 0;
}

function normalizeSupplierName(name) {
  if (!name && name !== 0) return '';
  return String(name).trim().toLowerCase().replace(/\s+/g, '').replace(/[^0-9a-zа-яё]/gi, '');
}

function getToday() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy'); }

function normalizeSheetDate(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'dd.MM.yyyy');
  }

  const raw = String(value || '').trim();
  if (!raw) return '';

  const dateMatch = raw.match(/(\d{1,2})[\.\/\-](\d{1,2})[\.\/\-](\d{4})/);
  if (!dateMatch) return raw;

  const [, day, month, year] = dateMatch;
  return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${year}`;
}

function getTodayOrderRows() {
  if (Object.keys(COL_IDX).length === 0) {
    initColumns();
  }

  const ordersSheet = SpreadsheetApp
    .openById(CONFIG.SPREADSHEET_ID)
    .getSheetByName(CONFIG.SHEETS.ORDERS);

  if (!ordersSheet) {
    throw new Error('❌ Не найдена таблица "Заказы"');
  }

  const lastRow = ordersSheet.getLastRow();
  if (lastRow < 3) return [];

  const lastColumn = ordersSheet.getLastColumn();
  const data = ordersSheet.getRange(3, 1, lastRow - 2, lastColumn).getValues();
  const today = getToday();
  const rows = [];

  data.forEach((row, i) => {
    const realRow = i + 3;
    const rowDate = normalizeSheetDate(row[COL_IDX.DATE]);
    if (rowDate !== today) return;

    const orderNum = String(row[COL_IDX.ORDER_NUM] || '').trim();
    const model = String(row[COL_IDX.MODEL] || '').trim();
    const supplier = String(row[COL_IDX.SUPPLIER] || '').trim();
    const client = String(row[COL_IDX.CLIENT] || '').trim();
    const address = String(row[COL_IDX.ADDRESS] || '').trim();

    if (!orderNum && !model && !supplier && !client && !address) return;

    rows.push({ rowIndex: realRow, row });
  });

  console.log(`📅 Найдено заказов на сегодня (${today}): ${rows.length}`);
  return rows;
}

function notifyTodayOrdersToPersonal(rows) {
  if (!CONFIG.CHAT_ID_PERSONAL) return;

  const orderNumbers = [...new Set(
    rows
      .map(({ row }) => String(row[COL_IDX.ORDER_NUM] || '').trim())
      .filter(Boolean)
  )];

  if (!orderNumbers.length) return;

  const text = `📋 Номера заказов на ${getToday()} (${orderNumbers.length}):\n` +
               orderNumbers.map((num, index) => `${index + 1}. ${num}`).join('\n');

  sendMessage(text, null, CONFIG.CHAT_ID_PERSONAL, CONFIG.SEND_MODE.FAST, null, { markdown: false });
}

function collectSuppliersFromRows(rows) {
  const supplierGroups = {};

  rows.forEach(({ row }) => {
    const supName = String(row[COL_IDX.SUPPLIER] || '').trim();
    if (!supName) return;

    const supNorm = normalizeSupplierName(supName);
    if (!supplierGroups[supNorm]) {
      supplierGroups[supNorm] = {
        name: supName,
        items: []
      };
    }

    supplierGroups[supNorm].items.push({ model: row[COL_IDX.MODEL] });
  });

  return supplierGroups;
}

function cleanAddress(addr) {
  return String(addr || '').replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').replace(/[,;]+/g, ',').trim();
}

// ===================== ЛОГИКА ЗАКАЗОВ =====================
// ===================== ЗАПИСЬ ТЕХНОБАЙ (ОДНОКРАТНАЯ) =====================
