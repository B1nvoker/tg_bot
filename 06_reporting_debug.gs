function writeReport(byn, usd, art, purp, userName = 'Система') {
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = ss.getSheetByName(CONFIG.SHEETS.REPORTS);
    if (!sheet) return;

    const rawHeaders = sheet.getRange(4, 1, 1, sheet.getLastColumn()).getValues()[0];
    const headers = rawHeaders.map(h => String(h).replace(/\s+/g, ' ').trim().toLowerCase());

    const rowData = new Array(rawHeaders.length).fill('');

    // Ищем индексы (теперь более гибко)
    const idxDate = headers.findIndex(h => h.includes('дата'));
    const idxByn = headers.findIndex(h => h.includes('byn') || h.includes('сумма'));
    const idxUsd = headers.findIndex(h => h.includes('usd') || h.includes('доллар'));
    const idxArt = headers.findIndex(h => h.includes('статья'));
    const idxPurp = headers.findIndex(h => h.includes('платежа'));
    const idxWho = headers.findIndex(h => h.includes('кто') || h.includes('выполнил') || h.includes('исполнитель'));

    if (idxDate !== -1) rowData[idxDate] = getToday();
    if (idxByn !== -1) rowData[idxByn] =  byn === '' ? '' : byn;
    if (idxUsd !== -1) rowData[idxUsd] =  usd === '' ? '' : usd;
    if (idxArt !== -1) rowData[idxArt] = art;
    if (idxPurp !== -1) rowData[idxPurp] = String(purp || '');
    if (idxWho !== -1) rowData[idxWho] = userName;

    sheet.appendRow(rowData);

  } catch (error) {
    console.error('Ошибка записи отчета:', error);
  }
}

// 🔥 БЕЗОПАСНАЯ ФУНКЦИЯ ДЛЯ ПОИСКА КОЛОНКИ СТАТУСА
function getStatusColumnIndex(sheet) {
  try {
    const headers = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];

    // 🔥 Ищем колонку "Статус" с разными вариантами написания
    for (let i = 0; i < headers.length; i++) {
      const header = String(headers[i]).trim().toLowerCase();
      if (header.includes('статус') || header.includes('status')) {
        return i + 1; // Google Sheets считает с 1
      }
    }

    // 🔥 Если не нашли - выбрасываем ошибку, НЕ используем fallback!
    throw new Error('❌ Критическая ошибка: Колонка "Статус" не найдена в таблице "Заказы"!');

  } catch (error) {
    console.error('Ошибка в getStatusColumnIndex:', error);
    throw error;
  }
}

// 🔥 ОПТИМИЗИРОВАННЫЙ updateOrderStatus С ПАКЕТНЫМ ОБНОВЛЕНИЕМ
function updateOrderStatus(rows, status) {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
      .getSheetByName(CONFIG.SHEETS.ORDERS);

    if (!sheet) {
      console.error('❌ Таблица "Заказы" не найдена');
      return;
    }

    const statusColumnIndex = getStatusColumnIndex(sheet);
    const cols = initColumns();
    const orderNumColumnIndex = cols.ORDER_NUM + 1;
    console.log(`📍 Колонка статуса: ${statusColumnIndex}`);

    const validRows = [...new Set(rows.filter(row => row > 2))].sort((a, b) => a - b);
    if (!validRows.length) {
      return { updated: 0, deleted: 0, updatedRows: [], deletedRows: [] };
    }

    const minRow = validRows[0];
    const maxRow = validRows[validRows.length - 1];
    const rowCount = maxRow - minRow + 1;
    const orderValues = sheet.getRange(minRow, orderNumColumnIndex, rowCount, 1).getValues();
    const statusValues = sheet.getRange(minRow, statusColumnIndex, rowCount, 1).getValues();

    const rowGroups = {};
    const deletedRows = [];
    const updatedRows = [];

    validRows.forEach(row => {
      try {
        const offset = row - minRow;
        const orderNumber = orderValues[offset]?.[0];
        const currentStatus = statusValues[offset]?.[0];

        if (orderNumber === '' || orderNumber === null || orderNumber === undefined) {
          deletedRows.push(row);
          return;
        }

        if (String(currentStatus) !== String(status)) {
          updatedRows.push(row);
          if (!rowGroups[statusColumnIndex]) {
            rowGroups[statusColumnIndex] = [];
          }
          rowGroups[statusColumnIndex].push([row, status]);
        }
      } catch (error) {
        console.error(`❌ Ошибка проверки строки ${row}:`, error.message);
        deletedRows.push(row);
      }
    });

    // 🔥 ПАКЕТНОЕ ОБНОВЛЕНИЕ (по колонкам)
    for (const [col, updates] of Object.entries(rowGroups)) {
      if (updates.length === 0) continue;

      // Сортируем по возрастанию строк
      updates.sort((a, b) => a[0] - b[0]);

      // 🔥 Объединяем смежные строки в диапазоны
      let startRow = updates[0][0];
      let endRow = startRow;
      let currentStatus = updates[0][1];

      for (let i = 1; i <= updates.length; i++) {
        if (i < updates.length &&
            updates[i][0] === endRow + 1 &&
            updates[i][1] === currentStatus) {
          // Смежные строки с одинаковым статусом
          endRow = updates[i][0];
        } else {
          // Конец диапазона - обновляем пакетно
          const range = sheet.getRange(startRow, Number(col), endRow - startRow + 1, 1);
          const statusArray = new Array(endRow - startRow + 1).fill([currentStatus]);
          range.setValues(statusArray);

          console.log(`✅ Обновлен диапазон строк ${startRow}-${endRow}: ${currentStatus}`);

          if (i < updates.length) {
            startRow = updates[i][0];
            endRow = startRow;
            currentStatus = updates[i][1];
          }
        }
      }
    }

    // 🔥 Логирование результатов
    console.log(`📊 Итог обновления статусов:
    • Всего строк: ${rows.length}
    • Обновлено: ${updatedRows.length}
    • Удалено/не найдено: ${deletedRows.length}`);

    // 🔥 Уведомление если были проблемы
    if (deletedRows.length > 0 && CONFIG.DEBUG) {
      const msg = `⚠️ Внимание: ${deletedRows.length} строк не найдены в таблице`;
      sendMessage(msg, null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.QUEUE, null, { markdown: false });
    }

    return {
      updated: updatedRows.length,
      deleted: deletedRows.length,
      updatedRows: updatedRows,
      deletedRows: deletedRows
    };

  } catch (error) {
    console.error('❌ Критическая ошибка в updateOrderStatus:', error);

    const errorMsg = `🚨 Ошибка обновления статусов\nПроблема: ${error.message}`;
    sendMessage(errorMsg, null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST, null, { markdown: false });

    throw error;
  }
}

// 🔥 ОБНОВЛЕННАЯ updateStatusByOrderNum С ДИНАМИЧЕСКОЙ КОЛОНКОЙ СТАТУСА
function updateStatusByOrderNum(num, status) {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEETS.ORDERS);
    if (!sheet) {
      console.error('❌ Таблица "Заказы" не найдена');
      return;
    }

    // 🔥 Используем ту же функцию для поиска колонки статуса
    const statusColumnIndex = getStatusColumnIndex(sheet);
    console.log(`📍 updateStatusByOrderNum: колонка статуса = ${statusColumnIndex}`);

    const lastRow = sheet.getLastRow();
    if (lastRow < 3) return;

    // 🔥 Используем динамический поиск колонки ORDER_NUM
    const cols = initColumns();
    const orderNumColIdx = cols.ORDER_NUM + 1;

    const range = sheet.getRange(1, orderNumColIdx, lastRow, 1);
    const cells = range.createTextFinder(String(num).trim()).matchEntireCell(true).findAll();

    if (cells.length === 0) {
      console.log(`ℹ️ Номер заказа "${num}" не найден в таблице`);
      return;
    }

    let updatedCount = 0;
    cells.forEach(c => {
      const row = c.getRow();

      // 🔥 Пропускаем заголовки и удаленные строки
      if (row <= 2) return;

      const statusCell = sheet.getRange(row, statusColumnIndex);
      const currentStatus = statusCell.getValue();

      // 🔥 Проверяем, что строка не удалена
      if (statusCell.isBlank() && currentStatus === '' && sheet.getRange(row, orderNumColIdx).isBlank()) {
        console.warn(`⚠️ Строка ${row} возможно удалена (пустые данные)`);
        return;
      }

      // 🔥 Обновляем только если статус изменился
      if (String(currentStatus) !== String(status)) {
        statusCell.setValue(status);
        updatedCount++;
        console.log(`✅ Обновлен статус заказа ${num} в строке ${row}: ${currentStatus} → ${status}`);
      }
    });

    console.log(`📊 Обновлено статусов для заказа ${num}: ${updatedCount} строк`);

  } catch (error) {
    console.error('Ошибка в updateStatusByOrderNum:', error);

    // 🔥 Отправляем уведомление об ошибке
    if (CONFIG.DEBUG) {
      const errorMsg = `❌ Ошибка обновления статуса заказа ${num}:\n${error.message}`;
      sendMessage(errorMsg, null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST);
    }
  }
}

function getUsdRateCached() {
  const cached = getWithTTL('usd_rate');
  if (cached) return cached;

  const lastGoodRate = Number(scriptProps.getProperty('usd_rate_last_good') || 0);

  try {
    const response = UrlFetchApp.fetch('https://api.nbrb.by/exrates/rates/USD?parammode=2', {
      muteHttpExceptions: true
    });
    const statusCode = response.getResponseCode();
    const data = JSON.parse(response.getContentText());
    const rate = Number(data?.Cur_OfficialRate);

    if (statusCode !== 200 || !Number.isFinite(rate) || rate <= 0) {
      throw new Error(`NBRB returned invalid rate: HTTP ${statusCode}`);
    }

    setWithTTL('usd_rate', rate, 720);
    scriptProps.setProperty('usd_rate_last_good', String(rate));
    return rate;
  } catch (e) {
    if (lastGoodRate > 0) {
      console.warn(`⚠️ Не удалось обновить курс USD, использую последнее сохраненное значение: ${lastGoodRate}`);
      return lastGoodRate;
    }

    console.error('❌ Не удалось получить курс USD:', e);
    return 1;
  }
}

function getRouteKey(chatId = null) {
  return `route_${chatId || CONFIG.CHAT_ID}`;
}

function buildRoute(chatId) {
  const key = getRouteKey(chatId);
  const addresses = getWithTTL(key);

  if (!addresses || !addresses.length) {
    return sendMessage('📭 *Маршрут пуст*\\. Добавьте адреса кнопкой «➕ В маршрут»', null, chatId);
  }

  sendMessage('🔄 _Строю маршрут, подождите..._', null, chatId);

  const coords = addresses.map(addr => {
    try {
      const url = `https://geocode-maps.yandex.ru/1.x/?format=json&apikey=${CONFIG.YANDEX_API_KEY}&geocode=${encodeURIComponent(cleanAddress(addr))}`;
      const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      const res = JSON.parse(resp.getContentText());
      const pos = res.response?.GeoObjectCollection?.featureMember[0]?.GeoObject?.Point?.pos;
      return pos ? pos.split(' ').reverse().join(',') : null;
    } catch(e) {
      logDebug('Geocode error for ' + addr + ': ' + e.message);
      return null;
    }
  }).filter(c => c);

  if (!coords.length) {
    return sendMessage('❌ Не удалось найти координаты для адресов в списке', null, chatId);
  }

  const routeUrl = `https://yandex.ru/maps/?rtext=~${coords.join('~')}&rtt=auto`;
  const count = addresses.length;
  const text = mdSafe(`🚗 Маршрут построен (${count} точек)`);

  const kb = {
    inline_keyboard: [
      [{ text: '🗺️ Открыть Яндекс Карты', url: routeUrl }],
      [{ text: '🗑️ Очистить маршрут', callback_data: 'clear_route_confirm' }]
    ]
  };

  sendMessage(text, kb, chatId);
}

function handleVamPhoto(msg) {
  const chatId = msg.chat.id;
  const step = getWithTTL(`vam_step_${chatId}`);

  if (step !== 'vam_wait_photo') {
    sendMessage('⚠️ Фото уже получено. Введите сумму.', null, chatId);
    return;
  }
  const fileId = msg.photo[msg.photo.length - 1].file_id;
  const fileResp = UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TOKEN}/getFile?file_id=${fileId}`, {
    muteHttpExceptions: true
  });
  const res = JSON.parse(fileResp.getContentText());

  if (fileResp.getResponseCode() !== 200 || !res.ok || !res.result?.file_path) {
    throw new Error(res.description || 'Не удалось получить путь к файлу Telegram');
  }

  const blob = UrlFetchApp.fetch(`https://api.telegram.org/file/bot${CONFIG.TOKEN}/${res.result.file_path}`).getBlob();
  const file = DriveApp.getFolderById(CONFIG.OCR_FOLDER_ID).createFile(blob);
  const result = processVamExpressOCR(file);
  setWithTTL(`vam_step_${chatId}`, 'vam_wait_sum', 30);
  sendMessage(`🧾 OCR обработан: найдено строк — ${result.count}\n\n💰 Введите фактически полученную сумму`,
  null, chatId, CONFIG.SEND_MODE.FAST, null, { markdown: false });
}

function clearStates(chatId, uid = null) {
  const keys = [
    `gm_step_${chatId}`,
    `gm_sum_${chatId}`,
    `buyusd_step_${chatId}`,
    `vam_step_${chatId}`,
    `price_step_${chatId}`,
    `extra_edit_sum_${chatId}`
  ];
  keys.forEach(k => scriptProps.deleteProperty(k));

  if (uid) {
    scriptProps.deleteProperty(uid);
    scriptProps.deleteProperty(`ttl_${uid}`); // 🔥 ДОБАВЛЕНО
    scriptProps.deleteProperty(`real_price_${uid}`);
    scriptProps.deleteProperty(`ttl_real_price_${uid}`);
  }
}

function ensureQueueTrigger() {
  if (!ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'processQueueFast')) {
    ScriptApp.newTrigger('processQueueFast').timeBased().everyMinutes(1).create();
  }
}

// 🔥 ОБНОВЛЕННАЯ ФУНКЦИЯ БАЛАНСА С ДИНАМИЧЕСКИМ ПОИСКОМ
function sendMoneyBalance(chatId) {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
      .getSheetByName(CONFIG.SHEETS.REPORTS);

    if (!sheet) {
      sendMessage('❌ Лист "Отчёты" не найден', null, chatId);
      return;
    }

    // 🔥 ПРЯМОЕ ЧТЕНИЕ ИЗ КОНКРЕТНЫХ ЯЧЕЕК (G1 и H1)
    let byn = '', usd = '';

    try {
      // BYN находится в ячейке G1 (столбец 7, строка 1)
      byn = sheet.getRange('G1').getValue();
    } catch (e) {
      console.warn('Не удалось прочитать BYN из G1:', e.message);
    }

    try {
      // USD находится в ячейке H1 (столбец 8, строка 1)
      usd = sheet.getRange('H1').getValue();
    } catch (e) {
      console.warn('Не удалось прочитать USD из H1:', e.message);
    }

    // 🔥 ФОРМАТИРУЕМ ДЛЯ ОТОБРАЖЕНИЯ (два знака после запятой)
    const formattedByn = formatPriceForDisplay(byn);
    const formattedUsd = formatPriceForDisplay(usd);

    // 🔥 ЭКРАНИРУЕМ ДЛЯ MARKDOWN
    const safeByn = mdSafe(formattedByn);
    const safeUsd = mdSafe(formattedUsd);

    // 🔥 ФОРМАТИРОВАННЫЙ ОТВЕТ
    const message = `📊 *Баланс*\n` +
                   `Должно быть: ${safeByn} руб\n` +
                   `Доллары: ${safeUsd} USD`;

    sendMessage(
      message,
      null,
      chatId,
      CONFIG.SEND_MODE.FAST,
      null,
      { markdown: true }
    );

    console.log(`✅ Баланс отправлен: BYN=${formattedByn}, USD=${formattedUsd}`);

  } catch (error) {
    console.error('❌ Ошибка в sendMoneyBalance:', error);
    sendMessage(
      `❌ Ошибка получения баланса:\n${error.message}`,
      null,
      chatId,
      CONFIG.SEND_MODE.FAST,
      null,
      { markdown: false }
    );
  }
}

function editMessageText(chatId, messageId, text, useMarkdown = true) {
  try {
    const payload = {
      chat_id: chatId,
      message_id: messageId,
      text: text
    };

    if (useMarkdown) {
      payload.parse_mode = 'MarkdownV2';
    }

    UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TOKEN}/editMessageText`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch(e) {
    logDebug('editMessageText error: ' + e.message);
  }
}

function editMessageReplyMarkup(chatId, messageId, keyboard) {
  try {
    UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TOKEN}/editMessageReplyMarkup`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: keyboard
      }),
      muteHttpExceptions: true
    });
  } catch(e) {
    logDebug('editMessageReplyMarkup error: ' + e.message);
  }
}

function answerCb(id, text) {
  UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TOKEN}/answerCallbackQuery`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ callback_query_id: id, text: text })
  });
}

function logDebug(msg) {
  const cleanMsg = String(msg || '');
  console.log(cleanMsg);

  // 🔥 ЗАЩИТА: не отправляем в Telegram если содержит ошибки парсинга Markdown
  if (cleanMsg.includes('Bad Request') ||
      cleanMsg.includes('parse_mode') ||
      cleanMsg.includes('markdown')) {
    return;
  }

  // 🔥 ЛИМИТ: отправляем только 30% сообщений в DEBUG режиме
  if (CONFIG.DEBUG && !cleanMsg.includes('LOG:') && Math.random() < 0.3) {
    try {
      UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TOKEN}/sendMessage`, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: CONFIG.CHAT_ID,
          text: `LOG: ${cleanMsg.slice(0, 1000)}`,
          parse_mode: null,
          disable_web_page_preview: true
        }),
        muteHttpExceptions: true
      });
    } catch(e) {
      // Молчим об ошибках отправки логов
    }
  }
}

// 🔥 ФУНКЦИЯ ДЛЯ ПРОВЕРКИ СОСТОЯНИЯ БОТА
function botHealthCheck() {
  const checks = [];

  // 1. Проверка доступа к таблице
  try {
    const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    checks.push({ name: 'Таблица', status: '✅' });
  } catch (e) {
    checks.push({ name: 'Таблица', status: '❌', error: e.message });
  }

  // 2. Проверка колонок
  try {
    initColumns();
    checks.push({ name: 'Колонки', status: '✅', info: Object.keys(COL_IDX).length + ' колонок' });
  } catch (e) {
    checks.push({ name: 'Колонки', status: '❌', error: e.message });
  }

  // 3. Проверка Telegram API
  try {
    const resp = UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TOKEN}/getMe`, {
      muteHttpExceptions: true
    });
    const data = JSON.parse(resp.getContentText());
    checks.push({ name: 'Telegram API', status: data.ok ? '✅' : '❌', info: data.ok ? 'Бот доступен' : data.description });
  } catch (e) {
    checks.push({ name: 'Telegram API', status: '❌', error: e.message });
  }

  // 4. Проверка папки OCR
  try {
    const folder = DriveApp.getFolderById(CONFIG.OCR_FOLDER_ID);
    checks.push({ name: 'Папка OCR', status: '✅', info: folder.getName() });
  } catch (e) {
    checks.push({ name: 'Папка OCR', status: '❌', error: e.message });
  }

  // 🔥 5. Проверка листа ТБ (НОВОЕ)
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
      .getSheetByName(CONFIG.SHEETS.TB);
    if (sheet) {
      const lastRow = sheet.getLastRow();
      const rowCount = Math.max(0, lastRow - 1); // вычитаем заголовок
      checks.push({
        name: 'Лист ТБ',
        status: '✅',
        info: `название: "${sheet.getName()}", строк: ${rowCount}`
      });
    } else {
      checks.push({
        name: 'Лист ТБ',
        status: '⚠️',
        error: 'Лист не найден, но это может быть нормально (запись будет пропущена)'
      });
    }
  } catch (e) {
    checks.push({ name: 'Лист ТБ', status: '❌', error: e.message });
  }

  // 6. Проверка данных поставщиков (кеширование)
  try {
    const suppliersData = getSuppliersData();
    const suppliersCount = Object.keys(suppliersData.supInfo).length;
    checks.push({
      name: 'Справочник поставщиков',
      status: '✅',
      info: `${suppliersCount} поставщиков (кешировано)`
    });
  } catch (e) {
    checks.push({ name: 'Справочник поставщиков', status: '❌', error: e.message });
  }

  // Формируем отчет
  const failed = checks.filter(c => c.status === '❌');
  const warnings = checks.filter(c => c.status === '⚠️');
  const report = checks.map(c =>
    `${c.status} ${c.name}` + (c.info ? ` (${c.info})` : '') + (c.error ? `: ${c.error}` : '')
  ).join('\n');

  // 🔥 Отправляем отчет если есть ошибки или в режиме DEBUG
  if (failed.length > 0 || CONFIG.DEBUG) {
    const statusEmoji = failed.length > 0 ? '❌' : (warnings.length > 0 ? '⚠️' : '✅');
    sendMessage(`🔍 *Проверка здоровья бота* ${statusEmoji}\n\n${report}`,
               null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST);
  }

  return {
    checks,
    allOk: failed.length === 0,
    hasWarnings: warnings.length > 0
  };
}

// 🔥 ФУНКЦИЯ ДЛЯ ПРОВЕРКИ ИСПОЛЬЗОВАНИЯ ПАМЯТИ
function checkMemoryUsage() {
  const props = scriptProps.getProperties();
  const propsSize = JSON.stringify(props).length;
  const propsCount = Object.keys(props).length;

  console.log(`📊 Использование памяти ScriptProperties:`);
  console.log(`   • Ключей: ${propsCount}`);
  console.log(`   • Размер: ${(propsSize / 1024).toFixed(2)} KB`);
  console.log(`   • Лимит: ~500 KB`);
  console.log(`   • Использовано: ${((propsSize / 500000) * 100).toFixed(1)}%`);

  // Уведомление если превышаем 70%
  if (propsSize > 350000 && CONFIG.DEBUG) {
    sendMessage(
      `⚠️ *ВНИМАНИЕ: ScriptProperties на ${((propsSize / 500000) * 100).toFixed(1)}%*\n` +
      `Ключей: ${propsCount}\n` +
      `Рекомендуется запустить очистку в меню Бота → Очистить старые свойства`,
      null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST
    );
  }

  return { size: propsSize, count: propsCount, percent: (propsSize / 500000) * 100 };
}

// 🔥 НОВАЯ ФУНКЦИЯ ДЛЯ ПРОВЕРКИ КОЛОНКИ СТАТУСА
function checkStatusColumn() {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
      .getSheetByName(CONFIG.SHEETS.ORDERS);

    const colIndex = getStatusColumnIndex(sheet);
    const headers = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
    const statusHeader = headers[colIndex - 1];

    const ui = SpreadsheetApp.getUi();
    ui.alert(
      '✅ Колонка статуса найдена',
      `Колонка: ${colIndex}\nЗаголовок: "${statusHeader}"\nВсе заголовки:\n${headers.map((h,i) => `${i+1}: "${h}"`).join('\n')}`,
      ui.ButtonSet.OK
    );

  } catch (error) {
    const ui = SpreadsheetApp.getUi();
    ui.alert(
      '❌ Ошибка поиска колонки статуса',
      error.message,
      ui.ButtonSet.OK
    );
  }
}

function checkSheetStructure() {
  const ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  let report = "🔍 **ОТЧЕТ ПО ПРОВЕРКЕ КОЛОНОК**\n\n";

  // 1. ПРОВЕРКА ЛИСТА "Заказы"
  const orderSheet = ss.getSheetByName(CONFIG.SHEETS.ORDERS);
  if (!orderSheet) {
    report += "❌ Лист 'Заказы' НЕ НАЙДЕН\n";
  } else {
    report += "--- ЛИСТ 'ЗАКАЗЫ' (Заголовки во 2-й строке) ---\n";
    const headers = orderSheet.getRange(2, 1, 1, orderSheet.getLastColumn()).getValues()[0]
      .map(h => String(h).trim());

    for (const [key, expectedName] of Object.entries(CONFIG.COLUMN_NAMES)) {
      const idx = headers.indexOf(expectedName);
      if (idx !== -1) {
        report += `✅ ${expectedName} (Колонка ${idx + 1})\n`;
      } else {
        report += `❌ НЕ НАЙДЕНА: "${expectedName}"\n`;
      }
    }
  }

  report += "\n";

  // 2. ПРОВЕРКА ЛИСТА "Отчёты"
  const reportSheet = ss.getSheetByName(CONFIG.SHEETS.REPORTS);
  if (!reportSheet) {
    report += "❌ Лист 'Отчёты' НЕ НАЙДЕН\n";
  } else {
    report += "--- ЛИСТ 'ОТЧЁТЫ' (Заголовки в 1-й строке) ---\n";
    const headers = reportSheet.getRange(1, 1, 1, reportSheet.getLastColumn()).getValues()[0]
      .map(h => String(h).trim());

    // Список того, что ищет функция writeReport
    const required = ['Дата', 'BYN', 'USD', 'Статья', 'Назначение платежа', 'Кто выполнил'];

    required.forEach(name => {
      const idx = headers.findIndex(h => h.toLowerCase().includes(name.toLowerCase()));
      if (idx !== -1) {
        report += `✅ ${name} (найдена как "${headers[idx]}", №${idx + 1})\n`;
      } else {
        report += `❌ КРИТИЧНО: Колонка для "${name}" не опознана\n`;
      }
    });
  }

  // ВЫВОД РЕЗУЛЬТАТА
  const ui = SpreadsheetApp.getUi();
  const html = HtmlService.createHtmlOutput('<pre style="font-family: sans-serif;">' + report + '</pre>')
    .setWidth(500)
    .setHeight(600);
  ui.showModelessDialog(html, "Результат проверки структуры");

  // Дополнительно дублируем в консоль
  console.log(report);
}
