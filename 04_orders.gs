function logTechnoBayForTodayOnce() {
  try {
    if (Object.keys(COL_IDX).length === 0) {
      initColumns();
    }

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const orderSheet = ss.getSheetByName(CONFIG.SHEETS.ORDERS);
    if (!orderSheet) return;

    const lastRow = orderSheet.getLastRow();
    if (lastRow < 3) return;

    const data = orderSheet.getRange(3, 1, lastRow - 2, orderSheet.getLastColumn()).getValues();
    const todayStr = getToday();
    const technoNorm = normalizeSupplierName('Технобай');

    let processedCount = 0;
    let skippedCount = 0;

    data.forEach((row, i) => {
      // Проверка даты
      const rowDateStr = normalizeSheetDate(row[COL_IDX.DATE]);

      if (rowDateStr !== todayStr) return;

      // Проверка поставщика
      const supName = String(row[COL_IDX.SUPPLIER] || '').trim();
      if (normalizeSupplierName(supName) !== technoNorm) return;

      // Проверка номера заказа
      const orderNum = String(row[COL_IDX.ORDER_NUM] || '').trim();
      if (!orderNum) {
        skippedCount++;
        console.log(`⚠️ Пропускаем Технобай без номера заказа в строке ${i + 3}`);
        return;
      }

      // Проверка дубля
      const tbKey = `tb_${orderNum}_${todayStr}`;
      if (getWithTTL(tbKey)) {
        skippedCount++;
        console.log(`⏩ Пропускаем дубль Технобай: ${orderNum}`);
        return;
      }

      // Запись в лист ТБ
      syncWithTechnoBay(todayStr, row[COL_IDX.MODEL], row[COL_IDX.SUP_PRICE_BYN]);
      setWithTTL(tbKey, true, 1440);
      processedCount++;

      console.log(`✅ Записан Технобай в ТБ: ${orderNum} - ${row[COL_IDX.MODEL]}`);
    });

    if (CONFIG.DEBUG) {
      sendMessage(`📊 Запись Технобая за ${todayStr}: ${processedCount} записей, ${skippedCount} пропущено`,
                 null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST, null, { markdown: false });
    }

  } catch (error) {
    console.error('❌ Ошибка в logTechnoBayForTodayOnce:', error);
  }
}

// ===================== ОБНОВЛЕННАЯ collectSuppliersForToday =====================
function collectSuppliersForToday() {
  try {
    if (Object.keys(COL_IDX).length === 0) {
      initColumns();
    }

    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const orderSheet = ss.getSheetByName(CONFIG.SHEETS.ORDERS);

    const lastRow = orderSheet.getLastRow();
    if (lastRow < 2) return {};

    const data = orderSheet.getRange(3, 1, lastRow - 2, orderSheet.getLastColumn()).getValues();
    const todayStr = getToday();
    const supplierGroups = {};

    data.forEach((row, i) => {
      const rowDateStr = normalizeSheetDate(row[COL_IDX.DATE]);

      if (rowDateStr !== todayStr) return;

      const supName = String(row[COL_IDX.SUPPLIER]).trim();
      if (!supName) return;

      const supNorm = normalizeSupplierName(supName);

      // 🔴 ВАЖНО: ТОЛЬКО группировка, БЕЗ записи в ТБ
      if (!supplierGroups[supNorm]) {
        supplierGroups[supNorm] = {
          name: supName,
          items: []
        };
      }
      supplierGroups[supNorm].items.push({ model: row[COL_IDX.MODEL] });
    });

    return supplierGroups;

  } catch (error) {
    console.error('❌ Ошибка в collectSuppliersForToday:', error);
    return {};
  }
}

function collectExtraTasksBySupplier() {
  const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEETS.EXTRA);
  if (!sheet || sheet.getLastRow() < 2) return {};

  const today = getToday();
  const data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 6).getValues();
  const map = {};

  data.forEach((r, i) => {
    const [date, art, sup, sum, cur, todo] = r;
    if (!(date instanceof Date)) return;
    if (Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd.MM.yyyy') !== today) return;

    const supNorm = sup ? normalizeSupplierName(sup) : '__NO_SUPPLIER__';
    const uid = `ex_${Utilities.getUuid().slice(0, 8)}`;

    // Сохраняем расширенные данные в кэш для дальнейшей обработки
    setWithTTL(uid, { art, todo, sum, cur: cur || 'BYN', sup }, 480); // 🔥 8 часов

    let text = `📌 *${mdSafe(art)}*\n${mdSafe(todo || sup)}`;
    if (art === 'Точка' && sup) {
      text += `\nПоставщик: ${mdSafe(sup)}`;
    }
    if (sum && art !== 'Точка') text += `\nСумма: ${formatNumber(sum)} ${cur || 'BYN'}`;

    let kb;
    if (art === 'Точка') {
      kb = {
        inline_keyboard: [
          [
            { text: '✅ Сделано', callback_data: `extra_done_${uid}` },
            { text: '❌ Не сделано', callback_data: `extra_notdone_${uid}` }
          ]
        ]
      };
    } else {
      kb = {
        inline_keyboard: [
          [{ text: '💰 Дал денег', callback_data: `extra_money_${uid}` }, { text: '❌ Не дал', callback_data: `extra_nomoney_${uid}` }],
          [{ text: '✏️ Изменение суммы', callback_data: `extra_changesum_${uid}` }]
        ]
      };
    }

    if (!map[supNorm]) map[supNorm] = [];
    map[supNorm].push({ text, kb, supName: sup, uid: uid });
  });
  return map;
}

// ===================== ОСНОВНАЯ ФУНКЦИЯ =====================
function sendOrdersToTelegram() {
   try {
      // 🔥 0. ПРОВЕРКА ЗДОРОВЬЯ (только в debug режиме)
      if (CONFIG.DEBUG && Math.random() < 0.1) { // 10% запусков
        const health = botHealthCheck();
        if (!health.allOk) {
          console.warn('⚠️ Проблемы в проверке здоровья:', health.checks.filter(c => c.status === '❌'));
        }
      }

      // 🔥 1. АВТОЛОГ ТЕХНОБАЙ ЗА СЕГОДНЯ
      const todayKey = `tb_logged_${getToday()}`;
      if (!getWithTTL(todayKey)) {
        logTechnoBayForTodayOnce();
        setWithTTL(todayKey, true, 1440);
      } else {
        console.log(`⏩ logTechnoBayForTodayOnce уже выполнен сегодня (${getToday()})`);
      }

      // 🔥 2. ИНИЦИАЛИЗИРУЕМ КОЛОНКИ (с кэшированием)
      initColumns();

      // 🔥 2. КЭШИРУЕМ ДАННЫЕ ПОСТАВЩИКОВ (ИСПРАВЛЕННЫЙ КОД)
      const { supInfo } = getSuppliersData();

    // 1. ✅ Заказы — ВСЕ строки, у которых дата в колонке B = сегодня
    const rows = getTodayOrderRows();

    if (!rows.length) {
      sendMessage(
        `ℹ️ На ${getToday()} нет заказов для отправки`,
        null,
        CONFIG.CHAT_ID,
        CONFIG.SEND_MODE.FAST,
        null,
        { markdown: false }
      );
      return;
    }

    notifyTodayOrdersToPersonal(rows);

    // 2. ✅ Поставщики — ВСЕ за сегодня
    const supplierSums = collectSuppliersFromRows(rows);

    // 3. ✅ Доп-дела — ВСЕ за сегодня
    const extraBySupplier = collectExtraTasksBySupplier();

    if (
      !Object.keys(supplierSums).length &&
      !Object.keys(extraBySupplier).length
    ) {
      sendMessage('ℹ️ Сегодня нет заборов у поставщиков', null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.QUEUE);
    }

    // 🔥 ЗАДАЧА 2: ДОП-ДЕЛА БЕЗ ПОСТАВЩИКА — В САМОМ НАЧАЛЕ
    if (extraBySupplier['__NO_SUPPLIER__']) {
      sendMessage('📌 *Дополнительные дела*', null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST);

      extraBySupplier['__NO_SUPPLIER__'].forEach(t => {
        sendMessage(t.text, t.kb, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST, t.uid);
      });
    }

    // 🔥 ОБРАБОТКА СЕГОДНЯШНИХ ЗАКАЗОВ
    const groups = { vam: {}, auto: {}, normal: {} };

    rows.forEach(({ row, rowIndex }) => {
      // 🔥 ИСПОЛЬЗУЕМ ДИНАМИЧЕСКИЕ ИНДЕКСЫ
      const delivery = String(row[COL_IDX.DELIVERY] || '').toLowerCase();
      const phone = String(row[COL_IDX.PHONE] || 'no_phone_' + rowIndex);

      const obj = {
        row: rowIndex,
        orderNumber: row[COL_IDX.ORDER_NUM],
        model: row[COL_IDX.MODEL],
        address: row[COL_IDX.ADDRESS],
        price: parsePrice(row[COL_IDX.PRICE_BYN]),
        deliveryPrice: parsePrice(row[COL_IDX.DELIVERY_COST]),
        client: row[COL_IDX.CLIENT],
        payment: row[COL_IDX.PAYMENT],
        phone: phone,
        supplier: row[COL_IDX.SUPPLIER],
        comment: row[COL_IDX.COMMENT],
        adOnliner: row[COL_IDX.AD_ONLINER],
        fromSource: row[COL_IDX.SOURCE],
        deliveryMethod: row[COL_IDX.DELIVERY]
      };

      if (delivery.includes('вамэкспресс')) {
        if (!groups.vam[phone]) groups.vam[phone] = [];
        groups.vam[phone].push(obj);
      }
      else if (delivery.includes('автолайт')) {
        if (!groups.auto[phone]) groups.auto[phone] = [];
        groups.auto[phone].push(obj);
      }
      else {
        if (!groups.normal[phone]) groups.normal[phone] = [];
        groups.normal[phone].push(obj);
      }
    });

    console.log(`📊 Группы: VAM=${Object.keys(groups.vam).length}, AUTO=${Object.keys(groups.auto).length}, NORMAL=${Object.keys(groups.normal).length}`);

    const orderedSuppliers = Object.keys(supplierSums)
      .sort((a, b) => supplierSums[a].name.localeCompare(supplierSums[b].name, 'ru'));

    // 🔥 ОТПРАВКА БЛОКОВ ПОСТАВЩИКОВ (ВСЕ за сегодня)
    if (orderedSuppliers.length > 0) {
      for (const supNorm of orderedSuppliers) {
        const supData = supplierSums[supNorm];
        const supName = supData.name;

        const info = supInfo[supNorm] || {};

        let txt = `🧾 *${mdSafe(supName)}*\n` + (info.addr ? `📍 ${mdSafe(info.addr)}\n` : '') +
                  (info.time ? `⏰ ${mdSafe(info.time)}\n` : '') + `\n🔽 *Забрать товар:*`;
        supData.items.forEach(it => txt += `\n• ${mdSafe(it.model)}`);
        sendMessage(txt, null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.QUEUE);

        if (extraBySupplier[supNorm]) {
          extraBySupplier[supNorm].forEach(t => {
            sendMessage(t.text, t.kb, CONFIG.CHAT_ID, CONFIG.SEND_MODE.QUEUE, t.uid);
          });
        }

      }
    }

    // 🔥 Доп-дела для поставщиков без забора товара
    for (const supNorm in extraBySupplier) {
      if (supNorm === '__NO_SUPPLIER__') continue;
      if (supplierSums[supNorm]) continue;

      const firstTask = extraBySupplier[supNorm][0];
      const supName = firstTask?.supName || supNorm;

      const info = supInfo[supNorm] || {};

      let txt = `🧾 *${mdSafe(supName)}*\n`;
      if (info.addr) txt += `📍 ${mdSafe(info.addr)}\n`;
      if (info.time) txt += `⏰ ${mdSafe(info.time)}\n`;

      txt += `\n📝 *Дополнительные дела:*`;

      sendMessage(txt, null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.QUEUE);

      extraBySupplier[supNorm].forEach(t => {
        sendMessage(t.text, t.kb, CONFIG.CHAT_ID, CONFIG.SEND_MODE.QUEUE, t.uid);
      });
    }

    // 🔥 ОТПРАВКА ВЫДЕЛЕННЫХ ЗАКАЗОВ (группированных)
    let totalSent = 0;

    if (Object.keys(groups.vam).length) {
      sendMessage('—————ВамЭкспресс—————', null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.QUEUE);
      Object.values(groups.vam).forEach(a => {
        sendCombinedOrdersMessage(a, 'vam');
        totalSent += a.length;
      });
    }
    if (Object.keys(groups.auto).length) {
      sendMessage('—————Автолайт—————', null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.QUEUE);
      Object.values(groups.auto).forEach(a => {
        sendCombinedOrdersMessage(a, 'autolight');
        totalSent += a.length;
      });
    }
    if (Object.keys(groups.normal).length) {
      sendMessage('—————По Минску—————', null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.QUEUE);
      Object.values(groups.normal).forEach(a => {
        sendCombinedOrdersMessage(a, 'normal');
        totalSent += a.length;
      });
    }

  } catch (error) {
    console.error('❌ Ошибка в sendOrdersToTelegram:', error);

    // 🔥 ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ ОШИБКИ
    const errorMsg = `*❌ Критическая ошибка бота*\n\n` +
                    `Ошибка: ${mdSafe(error.message)}\n` +
                    `Стек: ${mdSafe(error.stack?.split('\n')[0] || 'нет')}\n\n` +
                    `Время: ${new Date().toLocaleString('ru-RU')}`;

    sendMessage(errorMsg, null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST);

    // 🔥 ПРОБУЕМ ВОССТАНОВИТЬ КЭШ КОЛОНОК ПРИ ОШИБКЕ
    try {
      clearColumnCache();
      console.log('🔄 Кэш колонок очищен после ошибки');
    } catch (e) {
      console.error('Не удалось очистить кэш:', e);
    }
  }
}

// 🔥 ОПТИМИЗАЦИЯ: кэширование данных поставщиков (ТОЛЬКО адреса и время)
function getSuppliersData() {
  const cacheKey = 'suppliers_data_v2';
  const cached = CACHE.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const supSheet = ss.getSheetByName(CONFIG.SHEETS.SUPPLIERS);
  const supInfo = {};

  if (supSheet) {
    const data = supSheet.getDataRange().getValues();
    data.forEach((row, i) => {
      if (row[0]) {
        const normName = normalizeSupplierName(row[0]);
        // 🔴 ТОЛЬКО адрес и время, НЕ индексы строк
        supInfo[normName] = {
          addr: row[1],
          time: row[2],
          name: row[0]
        };
      }
    });
  }

  const result = { supInfo }; // 🔴 УБРАТЬ supplierRowMap
  CACHE.put(cacheKey, JSON.stringify(result), 1800); // 30 минут

  return result;
}

function sendCombinedOrdersMessage(items, type) {
  const first = items[0];
  const totalPrice = items.reduce((s, o) => s + o.price, 0);
  const nums = [...new Set(items.map(o => o.orderNumber))].join(', ');
  const uid = Utilities.getUuid().split('-')[0];

  setWithTTL(uid, {
    rows: items.map(o => o.row),
    orderNumbers: nums,
    totalPrice,
    address: first.address,
    payment: first.payment,
    orderType: type,
    fullData: items,
    phone: first.phone
  }, 720);

  // 🔥 ИСПРАВЛЕНИЕ: ЭКРАНИРУЕМ ВСЕ ЧИСЛА И ПЕРЕМЕННЫЕ
  let text = (type === 'normal')
    ? `*Заказы номер: ${mdSafe(nums)}*\n` +
      items.map(o => `📦 ${mdSafe(o.model)}`).join('\n') +
      `\nСумма: ${mdSafe(String(formatNumber(totalPrice)))} руб\\.\n` +
      `Способ оплаты: ${mdSafe(first.payment)}\n` +
      `Клиент: ${mdSafe(first.client)}\n` +
      `Телефон: ${mdSafe(first.phone)}\n` +
      `📍 ${mdSafe(first.address)}`
    : items.map(o => `📦 ${mdSafe(o.model)}`).join('\n') +
      `\n📍 ${mdSafe(first.address)}\n` +
      `Сумма: ${mdSafe(String(formatNumber(totalPrice)))} руб\\.`;

  // 🔥 ЭКРАНИРУЕМ КОММЕНТАРИЙ
  if (first.comment) text += `\n_❗Комментарий:_ ${mdSafe(first.comment)}`;

  // 🔥 ЭКРАНИРУЕМ РЕКЛАМУ
  if (type === 'normal' && needTryCancelOrder(first, totalPrice)) {
    const adCost = (totalPrice * (Number(first.adOnliner) || 0)) / 100;
    text += `\n\n‼️*Попробовать отменить заказ*\nРеклама: ${mdSafe(String(formatNumber(adCost)))} руб\\.`;
  }

  let kb;
  if (type === 'normal') {
    kb = {
      inline_keyboard: [
        [
          { text: '👍 Доставлено', callback_data: `delivered_${uid}` },
          { text: '💰 Цена изменена', callback_data: `pricechange_${uid}` }
        ],
        [
          { text: '❌ Не доставлен', callback_data: `notdelivered_${uid}` }
        ],
        [
          { text: '➕ В маршрут', callback_data: `routeadd_${uid}` }
        ]
      ]
    };
  } else {
    kb = {
      inline_keyboard: [
        [
          { text: '✅ Отправлено', callback_data: `${type}_${uid}` }
        ],
        [
          { text: '❌ Не отправлен', callback_data: `notsent_${uid}` }
        ]
      ]
    };
  }

  sendMessage(text, kb, first.chatId || CONFIG.CHAT_ID, CONFIG.SEND_MODE.QUEUE, uid);
}
function needTryCancelOrder(o, totalPrice) {
  if (!o.deliveryMethod || !o.fromSource) return false;

  const deliveryOk = String(o.deliveryMethod).toLowerCase().includes('курьер');
  const src = String(o.fromSource).toLowerCase();

  if (!deliveryOk) return false;
  if (!(src.includes('inote') || src.includes('tuf'))) return false;

  const adPercent = Number(o.adOnliner) || 0;
  const adCost = (totalPrice * adPercent) / 100;

  return adCost > 100;
}

// ===================== OCR ЛОГИКА =====================
function appendVamExpressGrouped(items) {
  const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEETS.ADDITIONAL);
  const grouped = {};
  items.forEach(o => {
    const key = o.phone || 'unknown';
    if (!grouped[key]) grouped[key] = { nums: new Set(), models: new Set(), price: 0, delivery: 0 };
    grouped[key].nums.add(o.orderNumber); grouped[key].models.add(o.model);
    if (CONFIG.PAYMENT_TYPES.CASH.includes(String(o.payment).toLowerCase())) grouped[key].price += Number(o.price) || 0;
    grouped[key].delivery += Number(o.deliveryPrice) || 0;
  });
  for (const k in grouped) { sheet.appendRow([Array.from(grouped[k].nums).join(', '), Array.from(grouped[k].models).join('\n'), grouped[k].price, grouped[k].delivery]); }
}

function extractSumsSmart(text) {
  const result = [];
  const hasBrokenNumbers = /\d\.\d{2},\s*\d\.\d{2}/.test(text);
  const hasZeroInTable = /0\.00\s+\d{2}\.\d{2}\s+\d{2}\.\d{2}/.test(text);
  if (hasBrokenNumbers) text = text.replace(/(\d)\.(\d{2}),\s*(\d)\.(\d{2})/g, (_, a, b, c, d) => (a + b + c) + '.' + d);
  text = text.replace(/(\d),(\d{3}\.)/g, '$1$2');

  // 🔥 ИСПРАВЛЕНИЕ: фильтруем NaN
  const nums = (text.match(/\b\d+\.\d{2}\b/g) || [])
    .map(n => Number(n))
    .filter(n => !isNaN(n)); // ✅ ЗАЩИТА ОТ NaN

  for (let i = 0; i < nums.length - 2; i++) {
    let sum = nums[i], fee = nums[i + 1], total = nums[i + 2];
    if (sum < 50 && !(sum === 0 && hasZeroInTable)) continue;
    if (fee < 10 || fee > 30) continue;
    if (sum === 0 && hasZeroInTable && Math.abs(fee - Math.abs(total)) < 0.05) {
      result.push([0, fee, -Math.abs(total)]);
      i += 2;
      continue;
    }
    if (Math.abs(sum - fee - total) < 0.05) {
      result.push([sum, fee, total]);
      i += 2;
      continue;
    }
    if (total >= 100 && total <= 999 && sum > 1000) {
      if (Math.abs(sum - fee - (total + 1000)) < 0.05) {
        result.push([sum, fee, total + 1000]);
        i += 2;
      }
    }
  }
  return result.sort((a, b) => b[0] - a[0]);
}

function processVamExpressOCR(file) {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const ocrSheet = ss.getSheetByName(CONFIG.SHEETS.OCR_SUMS);

    // Очищаем старые данные
    if (ocrSheet.getLastRow() > 1) {
      ocrSheet.deleteRows(2, ocrSheet.getLastRow() - 1);
    }

    // Создаем OCR документ
    const doc = Drive.Files.copy(
      { mimeType: 'application/vnd.google-apps.document' },
      file.getId(),
      { ocr: true, ocrLanguage: 'ru' }
    );

    // Получаем текст
    const text = DocumentApp.openById(doc.id).getBody().getText();

    // 🔥 ПОЛНОЕ УДАЛЕНИЕ ДОКУМЕНТА (не в корзину)
    try {
      Drive.Files.remove(doc.id); // Используем Drive API для полного удаления
      console.log(`🗑️ OCR документ полностью удален: ${doc.id}`);
    } catch (e) {
      console.warn('Не удалось полностью удалить OCR документ, помещаю в корзину');
      DriveApp.getFileById(doc.id).setTrashed(true); // fallback
    }

    // 🔥 УДАЛЯЕМ ИСХОДНЫЙ ФАЙЛ ИЗ ПАПКИ OCR
    try {
      file.setTrashed(true);
      console.log(`🗑️ Исходный файл помещен в корзину: ${file.getName()}`);
    } catch (e) {
      console.warn('Не удалось удалить исходный файл:', e);
    }

    const rows = extractSumsSmart(text);
    if (rows.length) {
      ocrSheet.getRange(2, 1, rows.length, 3).setValues(rows);
    }

    return { count: rows.length };

  } catch (error) {
    console.error('❌ Ошибка в processVamExpressOCR:', error);

    // 🔥 Отправляем уведомление об ошибке OCR
    if (CONFIG.DEBUG) {
      sendMessage(`❌ Ошибка обработки OCR:\n${error.message}`,
                 null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST);
    }

    throw error;
  }
}

// 🔥 БЕЗОПАСНАЯ editMessageFull С АВТОМАТИЧЕСКИМ ОТКЛЮЧЕНИЕМ MARKDOWN ПРИ ОШИБКАХ
function editMessageFull(chatId, messageId, text, keyboard = null, useMarkdown = true) {
  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: text,
      disable_web_page_preview: true
    };

    // 🔥 АВТОПРОВЕРКА: если текст содержит опасные символы, отключаем Markdown
    let finalUseMarkdown = useMarkdown;
    if (useMarkdown) {
      const unsafeChars = ['[', ']', '(', ')', '_', '*', '`', '~', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
      const hasUnsafeChars = unsafeChars.some(char =>
        text.includes(char) && !text.includes(`\\${char}`)
      );

      if (hasUnsafeChars) {
        console.log(`⚠️ Автоотключение Markdown: обнаружены опасные символы`);
        finalUseMarkdown = false;
      }
    }

    if (finalUseMarkdown) {
      payload.parse_mode = 'MarkdownV2';
    }

    if (keyboard) {
      payload.reply_markup = keyboard;
    }

    const response = UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TOKEN}/editMessageText`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const data = JSON.parse(response.getContentText());

    // 🔥 АВТОИСПРАВЛЕНИЕ: если ошибка Markdown, пробуем без него
    if (!data.ok && data.description && data.description.includes('parse_mode')) {
      console.log(`🔄 Повторная попытка без Markdown (ошибка: ${data.description})`);

      delete payload.parse_mode;
      const retryResponse = UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TOKEN}/editMessageText`, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      return JSON.parse(retryResponse.getContentText());
    }

    return data;

  } catch(e) {
    console.error('editMessageFull error:', e.message);
    return { ok: false, error: e.message };
  }
}

function reconcileVamExpress(realSum, userName = 'Система') {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

    // 🔥 ЗАЩИТА: проверяем OCR суммы
    const ocrSums = ss.getSheetByName(CONFIG.SHEETS.OCR_SUMS).getDataRange().getValues().slice(1)
      .map(r => {
        const val = String(r[2] || '').replace(/\u00A0/g,'').replace(/\s/g,'').replace(',','.');
        return Number(val);
      })
      .filter(v => !isNaN(v) && v > 0);

    if (!ocrSums.length) throw new Error('OCR не нашёл сумм в чеке');

    // 🔥 ЗАЩИТА: проверяем сумму
    const finalReal = Math.round(Number(realSum) * 100) / 100;
    if (isNaN(finalReal) || finalReal <= 0) {
      throw new Error(`Некорректная сумма: ${realSum}`);
    }

    const extraSheet = ss.getSheetByName(CONFIG.SHEETS.ADDITIONAL);
    const extraData = extraSheet.getDataRange().getValues().slice(1);

    let matchedOrders = [], matchedSum = 0;

    for (let i = extraData.length - 1; i >= 0; i--) {
      const orderSum = parsePrice(extraData[i][2]);
      const delivery = parsePrice(extraData[i][3]);
      const sumToGive = orderSum - delivery;

      const idx = ocrSums.findIndex(s => Math.abs(s - sumToGive) < 0.06);
      if (idx !== -1) {
        matchedOrders.push(String(extraData[i][0] || '').trim());
        matchedSum += sumToGive;
        extraSheet.deleteRow(i + 2);
        updateStatusByOrderNum(extraData[i][0], 'Продан');
        ocrSums.splice(idx, 1);
      }
    }

    // 🔥 ЗАЩИТА: проверяем matchedOrders перед join
    const ordersStr = matchedOrders.length > 0 ? matchedOrders.join(', ') : 'нет заказов';

    const status = (Math.abs(matchedSum - finalReal) < 0.1) ? 'Забрал с ВамЭкспресс' : '⚠️ Суммы не свелись';

    // 🔥 ЗАЩИТА: userName всегда есть
    const finalUserName = userName || 'Система';

    writeReport(finalReal, '', status, ordersStr, finalUserName);

    return {
      matchedSum,
      realSum: finalReal,
      orders: matchedOrders,
      status: status
    };

  } catch (error) {
    console.error('❌ Ошибка в reconcileVamExpress:', error);
    throw error; // 🔥 Пробрасываем выше для обработки в handleDialogs
  }
}

// ===================== ОБРАБОТЧИКИ =====================
