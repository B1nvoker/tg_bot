function TEST_USD_RATE() {
  const rate = getUsdRateCached();
  Logger.log('Текущий курс USD (НБРБ): ' + rate);
}

function testFolderAccess() {
  const folder = DriveApp.getFolderById(CONFIG.OCR_FOLDER_ID);
  Logger.log('Folder name: ' + folder.getName());
}

function testDrive() {
  DriveApp.getRootFolder().getName();
}

function grantDriveAuth() {
  return DriveApp.getRootFolder().getName();
}

// 🔥 БЕЗОПАСНЫЙ reset_all_state С ЛОГИРОВАНИЕМ
function reset_all_state() {
  if (!CONFIG.DEBUG) {
    sendMessage('❌ Сброс состояний запрещен в production режиме', null, CONFIG.CHAT_ID);
    return;
  }

  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    '⚠️ ОПАСНО!',
    'Вы действительно хотите сбросить ВСЕ состояния бота?\n\n' +
    'Это удалит:\n' +
    '• Очередь отправки сообщений\n' +
    '• Дополнительные дела\n' +
    '• Маршруты\n' +
    '• Состояния диалогов\n' +
    '• OCR состояния\n\n' +
    'Действие НЕЛЬЗЯ отменить!',
    ui.ButtonSet.YES_NO
  );

  if (response !== ui.Button.YES) return;

  try {
    // 🔥 ЛОГИРУЕМ ЧТО БЫЛО ДО УДАЛЕНИЯ
    const allProps = scriptProps.getProperties();
    const propCount = Object.keys(allProps).length;

    // Сохраняем критически важные данные
    const backupData = {
      timestamp: new Date().toISOString(),
      propertiesCount: propCount
    };

    // 🔥 СОЗДАЕМ ЛОГ В ТАБЛИЦЕ
    writeReport('', '', 'Система', `Сброс состояний бота (удалено ${propCount} свойств)`, 'Система');

    // Удаляем все свойства
    scriptProps.deleteAllProperties();

    // Очищаем CacheService - ИСПРАВЛЕННЫЙ КОД
    try {
      ['tg_queue_cache', 'column_indices', 'suppliers_data_v2', 'usd_rate']
        .forEach(k => CACHE.remove(k));
    } catch (e) {
      console.warn('Не удалось очистить CacheService:', e);
    }

    // 🔥 УВЕДОМЛЕНИЕ
    const msg = `✅ Все состояния сброшены\n\n` +
               `Удалено свойств: ${propCount}\n` +
               `Время: ${new Date().toLocaleString('ru-RU')}\n` +
               `Запись сохранена в Отчётах`;

    ui.alert('✅ Состояния сброшены', msg, ui.ButtonSet.OK);

    // Отправляем уведомление в Telegram
    sendMessage(msg, null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST, null, { markdown: false });

  } catch (error) {
    console.error('❌ Ошибка при сбросе состояний:', error);
    ui.alert('❌ Ошибка', 'Не удалось сбросить состояния: ' + error.message, ui.ButtonSet.OK);
  }
}

// 🔥 ОБНОВЛЕННАЯ initColumns С КЭШИРОВАНИЕМ
function initColumns(force = false) {
  if (!force && Object.keys(COL_IDX).length > 0) return COL_IDX;

  const cached = CACHE.get("column_indices");
  if (!force && cached) {
    COL_IDX = JSON.parse(cached);
    return COL_IDX;
  }

  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEETS.ORDERS);
    if (!sheet) throw new Error(`Не найдена таблица "${CONFIG.SHEETS.ORDERS}"`);

    // Берем заголовки со 2-й строки
    const rawHeaders = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];

    // 🔥 ОЧИСТКА: убираем переносы строк, двойные пробелы и невидимые символы
    const headers = rawHeaders.map(h =>
      String(h)
        .replace(/[\r\n\t]+/g, ' ') // Заменяем переносы и табуляцию на пробел
        .replace(/\s+/g, ' ')       // Заменяем двойные пробелы на один
        .trim()
    );

    console.log('🔍 Очищенные заголовки для поиска:', headers);

    COL_IDX = {};
    const missingColumns = [];

    for (const [key, name] of Object.entries(CONFIG.COLUMN_NAMES)) {
      // Ищем точное совпадение очищенного имени
      let idx = headers.indexOf(name.trim());

      // Если не нашли точно, пробуем найти по вхождению (на случай мелких несовпадений)
      if (idx === -1) {
        idx = headers.findIndex(h => h.toLowerCase().includes(name.toLowerCase().trim()));
      }

      if (idx === -1) {
        console.error(`❌ Колонка "${name}" не найдена!`);
        missingColumns.push(name);
      } else {
        COL_IDX[key] = idx;
      }
    }

    if (missingColumns.length > 0) {
      throw new Error(`Не найдены обязательные колонки: ${missingColumns.join(', ')}`);
    }

    CACHE.put("column_indices", JSON.stringify(COL_IDX), ONE_HOUR);
    return COL_IDX;

  } catch (error) {
    console.error('❌ Ошибка инициализации колонок:', error);
    throw error;
  }
}

// 🔥 ФУНКЦИЯ ДЛЯ ПРИНУДИТЕЛЬНОГО ОБНОВЛЕНИЯ
function refreshColumns() {
  initColumns(true);
  console.log('✅ Индексы колонок принудительно обновлены');
  sendMessage('🔄 Индексы колонок обновлены', null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST, null, { markdown: false });
}

// 🔥 ДОБАВИТЬ В bot() меню
function bot(ui) {
  ui.createMenu('Бот')
    .addItem('⚙️ Запустить выбранные заказы', 'sendOrdersToTelegram')
    .addSeparator()
    .addItem('✅ Очистить все статусы', 'reset_all_state')
    .addItem('🔄 Обновить индексы колонок', 'refreshColumns')
    .addItem('🧹 Очистить кэш колонок', 'clearColumnCache')
    .addItem('🧹 Очистить старые свойства', 'cleanupOldProperties')
    .addItem('🧩 Мигрировать CONFIG в JSON', 'migrateConfigToJson')
    .addItem('💾 Проверить использование памяти', 'checkMemoryUsage')
    .addItem('🗑️ Очистить папку OCR', 'manualCleanupOcr')
    .addItem('🔍 Проверить здоровье бота', 'botHealthCheck')
    .addSeparator()
    .addItem('🔧 Установить триггеры', 'setupAllTriggers')
    .addItem('⚠️ Проверить колонку статуса', 'checkStatusColumn') // 🔥 НОВАЯ ФУНКЦИЯ
    .addToUi();
  setBotCommands();
  ensureQueueTrigger();
}

// 🔥 ОЧИСТКА КЭША КОЛОНОК
function clearColumnCache() {
  CACHE.remove("column_indices");
  scriptProps.deleteProperty('COL_IDX_BACKUP');
  COL_IDX = {};
  console.log('✅ Кэш колонок очищен');
  const ui = SpreadsheetApp.getUi();
  ui.alert('✅ Кэш колонок очищен', 'При следующем запуске индексы будут пересчитаны.', ui.ButtonSet.OK);
}

// 🔥 АВТОМАТИЧЕСКОЕ БЭКАПИРОВАНИЕ ПРИ УСПЕШНОЙ ИНИЦИАЛИЗАЦИИ
function backupColumnIndices() {
  if (Object.keys(COL_IDX).length > 0) {
    scriptProps.setProperty('COL_IDX_BACKUP', JSON.stringify(COL_IDX));
    console.log('💾 Создан бэкап индексов колонок');
  }
}

// Вызовите backupColumnIndices() после успешной initColumns()

// ===================== ЕДИНЫЙ ЛОГГЕР ДЛЯ ТЕХНОБАЙ =====================
function syncWithTechnoBay(date, info, amount, userName = '') {
  try {
    const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(CONFIG.SHEETS.TB);
    if (!sheet) {
      console.error('❌ Лист ТБ не найден');
      // 🔥 В режиме DEBUG отправляем уведомление
      if (CONFIG.DEBUG) {
        sendMessage(`⚠️ Лист "${CONFIG.SHEETS.TB}" не найден. Запись Технобай не выполнена.`,
                   null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST, null, { markdown: false });
      }
      return;
    }

    const finalAmount = typeof amount === 'number' ? amount : parsePrice(amount);
    const finalInfo = userName ? `${info} (исп. ${userName})` : info;

    // 🔥 Проверяем, не пустые ли данные
    if (!info || finalAmount === 0) {
      console.warn(`⚠️ Попытка записи пустых данных в ТБ: ${info} - ${finalAmount}`);
      return;
    }

    sheet.appendRow([date, String(finalInfo).trim(), finalAmount]);
    console.log(`📝 Запись в ТБ: ${date} | ${info} | ${finalAmount}`);

    // 🔥 В режиме DEBUG отправляем подтверждение
    if (CONFIG.DEBUG) {
      sendMessage(`✅ Технобай записан в лист ТБ:\n${date} | ${info} | ${finalAmount} BYN`,
                 null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST, null, { markdown: false });
    }

  } catch (error) {
    console.error('❌ Ошибка записи в Технобай:', error);

    // 🔥 Отправляем уведомление об ошибке в Telegram
    if (CONFIG.DEBUG) {
      sendMessage(`❌ Ошибка записи в лист ТБ:\n${error.message}`,
                 null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST, null, { markdown: false });
    }
  }
}

// 🔥 ФУНКЦИЯ ОЧИСТКИ ПАПКИ OCR
function cleanUpOcrFolder(daysOld = 7) {
  try {
    const folder = DriveApp.getFolderById(CONFIG.OCR_FOLDER_ID);
    const files = folder.getFiles();
    const now = new Date();
    let deletedCount = 0;
    let errorCount = 0;

    while (files.hasNext()) {
      const file = files.next();
      const created = file.getDateCreated();
      const ageInDays = (now - created) / (1000 * 60 * 60 * 24);

      if (ageInDays > daysOld) {
        try {
          file.setTrashed(true);
          deletedCount++;
        } catch (e) {
          console.error(`Не удалось удалить файл ${file.getName()}:`, e);
          errorCount++;
        }
      }
    }

    console.log(`🧹 Очистка папки OCR: удалено ${deletedCount} файлов, ошибок: ${errorCount}`);

    if (CONFIG.DEBUG && deletedCount > 0) {
      sendMessage(`🧹 Очистка папки OCR\nУдалено файлов: ${deletedCount}\nОшибок: ${errorCount}`,
                 null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST, null, { markdown: false });
    }

    return { deleted: deletedCount, errors: errorCount };

  } catch (error) {
    console.error('❌ Ошибка очистки папки OCR:', error);
    return { deleted: 0, errors: 1 };
  }
}

// 🔥 ТРИГГЕР ДЛЯ ЕЖЕНЕДЕЛЬНОЙ ОЧИСТКИ
function setupCleanupTrigger() {
  // Удаляем старые триггеры
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'cleanUpOcrFolder')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // Создаем новый (каждое воскресенье в 3:00)
  ScriptApp.newTrigger('cleanUpOcrFolder')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(3)
    .create();

  console.log('✅ Триггер очистки папки OCR установлен (воскресенье 3:00)');
}

// 🔥 РУЧНАЯ ОЧИСТКА (добавить в меню)
function manualCleanupOcr() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    'Очистка папки OCR',
    'Удалить все временные файлы старше 7 дней?',
    ui.ButtonSet.YES_NO
  );

  if (response === ui.Button.YES) {
    const result = cleanUpOcrFolder(0); // 0 = удалить все
    ui.alert(
      'Готово',
      `Удалено файлов: ${result.deleted}\nОшибок: ${result.errors}`,
      ui.ButtonSet.OK
    );
  }
}

// 🔥 ФУНКЦИЯ ДЛЯ УСТАНОВКИ ВСЕХ ТРИГГЕРОВ
function setupAllTriggers() {
  ensureQueueTrigger();
  setupCleanupTrigger();

  // 🔥 ДОБАВИТЬ ТРИГГЕР ДЛЯ АВТООЧИСТКИ СВОЙСТВ
  setupPropertyCleanupTrigger();

  const ui = SpreadsheetApp.getUi();
  ui.alert('✅ Триггеры установлены',
           '• Очередь сообщений: каждую минуту\n' +
           '• Очистка OCR: каждое воскресенье 3:00\n' +
           '• Очистка свойств: каждый день в 4:00',
           ui.ButtonSet.OK);
}

// 🔥 ТРИГГЕР ДЛЯ ЕЖЕДНЕВНОЙ ОЧИСТКИ СВОЙСТВ
function setupPropertyCleanupTrigger() {
  // Удаляем старые триггеры
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'cleanupOldProperties')
    .forEach(t => ScriptApp.deleteTrigger(t));

  // Создаем новый (каждый день в 4:00)
  ScriptApp.newTrigger('cleanupOldProperties')
    .timeBased()
    .everyDays(1)
    .atHour(4)
    .create();

  console.log('✅ Триггер очистки свойств установлен (ежедневно 4:00)');
}

function setBotCommands() {
  const commands = [
    { command: 'mapping', description: 'Маршрут' },
    { command: 'vamexpress', description: 'ВамЭкспресс (Сверка)' },
    { command: 'buy_usd', description: 'Обмен валюты' },
    { command: 'give_money', description: 'Дать денег' },
    { command: 'money', description: 'Баланс' },
    { command: 'clear', description: 'Очистить чат' },
    { command: 'cancel', description: 'Отмена' }
  ];
  UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TOKEN}/setMyCommands`, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ commands })
  });
}

// ===================== TELEGRAM CORE =====================
