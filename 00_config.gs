


const scriptProps = PropertiesService.getScriptProperties();
const lockService = LockService.getScriptLock();
const userLockService = LockService.getUserLock(); // 🔥 ДОБАВИТЬ ДЛЯ АНТИ-ДАБЛКЛИКА

// 🔥 Глобальный объект для индексов колонок
let COL_IDX = {};

// ===================== НАСТРОЙКИ И КОНСТАНТЫ =====================
const CONFIG_PROPERTY_KEY = 'CONFIG';
const LEGACY_CONFIG_KEYS = [
  'TOKEN',
  'CHAT_ID',
  'CHAT_ID_PERSONAL',
  'SPREADSHEET_ID',
  'OCR_FOLDER_ID',
  'YANDEX_API_KEY',
  'DEBUG'
];

function getConfigObject() {
  const rawConfig = scriptProps.getProperty(CONFIG_PROPERTY_KEY);
  if (!rawConfig) return {};

  try {
    const parsed = JSON.parse(rawConfig);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('❌ Не удалось распарсить CONFIG JSON:', error);
    return {};
  }
}

function setConfig(config = {}) {
  const normalizedConfig = { ...getConfigObject(), ...config };
  scriptProps.setProperty(CONFIG_PROPERTY_KEY, JSON.stringify(normalizedConfig));
  return normalizedConfig;
}

function getConfigValue(key, fallback = '') {
  const config = getConfigObject();
  const configValue = config[key];
  if (configValue !== undefined && configValue !== null && configValue !== '') {
    return configValue;
  }

  const propValue = scriptProps.getProperty(key);
  return propValue !== null && propValue !== '' ? propValue : fallback;
}

function cleanupLegacyConfigProperties() {
  LEGACY_CONFIG_KEYS.forEach(key => scriptProps.deleteProperty(key));
}

function migrateConfigToJson() {
  const mergedConfig = { ...getConfigObject() };

  LEGACY_CONFIG_KEYS.forEach(key => {
    const legacyValue = scriptProps.getProperty(key);
    if (legacyValue !== null && legacyValue !== '') {
      mergedConfig[key] = key === 'DEBUG' ? legacyValue === 'true' : legacyValue;
    }
  });

  setConfig(mergedConfig);
  cleanupLegacyConfigProperties();

  const keysCount = Object.keys(mergedConfig).length;
  const ui = SpreadsheetApp.getUi();
  const message = `CONFIG JSON обновлен. Ключей внутри CONFIG: ${keysCount}. Старые отдельные свойства удалены.`;
  ui.alert('✅ Миграция CONFIG завершена', message, ui.ButtonSet.OK);

  if (CONFIG.CHAT_ID) {
    sendMessage(`✅ CONFIG перенесен в один JSON-объект. Ключей: ${keysCount}`,
      null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.FAST, null, { markdown: false });
  }

  return mergedConfig;
}

const CONFIG = {
  TOKEN: getConfigValue('TOKEN'),
  CHAT_ID: getConfigValue('CHAT_ID'),
  CHAT_ID_PERSONAL: getConfigValue('CHAT_ID_PERSONAL'),
  DEBUG: getConfigValue('DEBUG', 'false') === 'true',

  SPREADSHEET_ID: getConfigValue('SPREADSHEET_ID'),
  OCR_FOLDER_ID: getConfigValue('OCR_FOLDER_ID'),
  YANDEX_API_KEY: getConfigValue('YANDEX_API_KEY'),

  SHEETS: {
    ORDERS: 'Заказы',
    REPORTS: 'Отчёты',
    SUPPLIERS: 'Поставщики',
    ADDITIONAL: 'Дополнительный',
    OCR_SUMS: 'OCR_Суммы',
    TB: 'ТБ',
    EXTRA: 'Доп Дела'
  },

  // 🔥 ОБНОВЛЕННЫЕ НАЗВАНИЯ СТОЛБЦОВ (согласно вашему списку)
  COLUMN_NAMES: {
    DATE: 'Дата поставки',              // Используем дату доставки для фильтрации "на сегодня"
    ORDER_NUM: 'Номер заказа',
    COMMENT: 'Примечания к заказу',
    DELIVERY: 'Способ доставки',
    SOURCE: 'Откуда заказ',
    MODEL: 'Наименование модели',
    SUPPLIER: 'Поставщик',
    CLIENT: 'ФИО',
    PHONE: 'Телефон',
    ADDRESS: 'Адрес',
    PAYMENT: 'Карта',                   // Поле типа оплаты
    SUP_PRICE_BYN: 'Цена поставщика BYN',
    SUP_PRICE_USD: 'Цена поставщика USD',
    PRICE_BYN: 'Итоговая цена BYN',     // Финальная сумма к оплате клиентом
    DELIVERY_COST: 'Оплата доставки BYN', // Для вычитания доставки в ВамЭкспресс
    AD_ONLINER: 'Реклама Онлайнер'
  },

  SUPPLIERS: {
    GIVE_MONEY: ['РТЕЧ', 'Iven', 'Технобай', 'Вадим', 'Игорь', 'Артем', 'Другое']
  },

  PAYMENT_TYPES: {
    CASH: ['наличные', 'наличные чек']
  },

  SEND_MODE: {
    QUEUE: 'queue',
    FAST: 'fast'
  }
};

// 🔥 ДОБАВИТЬ В НАЧАЛО (после CONFIG)
const CACHE = CacheService.getScriptCache();
const ONE_HOUR = 3600; // секунд

// 🔥 ГЛОБАЛЬНЫЕ КОНСТАНТЫ ДЛЯ КЭША
const CACHE_TTL = {
  SHORT: 1800,    // 30 минут
  MEDIUM: 3600,   // 1 час
  LONG: 7200,     // 2 часа
  DAY: 86400      // 24 часа
};
