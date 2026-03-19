function sendTelegram(payload) {
  try {
    // 🔥 ПРЕДВАРИТЕЛЬНАЯ ПРОВЕРКА ТЕКСТА НА ОШИБКИ MARKDOWN
    if (payload.parse_mode === 'MarkdownV2') {
      // Проверяем незакрытые скобки и прочие ошибки
      const text = payload.text || '';
      const openBrackets = (text.match(/\[/g) || []).length;
      const closeBrackets = (text.match(/\]/g) || []).length;

      if (openBrackets !== closeBrackets) {
        console.warn('⚠️ Обнаружены незакрытые скобки Markdown, отключаю разметку');
        delete payload.parse_mode;
      }
    }

    const resp = UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TOKEN}/sendMessage`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    // 🔥 АНАЛИЗ ОТВЕТА
    const responseText = resp.getContentText();
    let data = {};
    try {
      data = JSON.parse(responseText);
    } catch(e) {
      logDebug('JSON parse error: ' + e.message + ', response: ' + responseText.substring(0, 200));
      return { ok: false, description: 'Invalid JSON response' };
    }

    // 🔥 АВТОМАТИЧЕСКОЕ ИСПРАВЛЕНИЕ MARKDOWN ОШИБОК
    if (!data.ok && data.description && data.description.includes('parse_mode')) {
      console.log('🔄 Markdown error detected, retrying without formatting');

      // Убираем Markdown и пробуем снова
      delete payload.parse_mode;
      const retryResp = UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TOKEN}/sendMessage`, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });

      try {
        return JSON.parse(retryResp.getContentText());
      } catch(e) {
        return { ok: false, description: 'Retry failed' };
      }
    }

    // 🔥 СОХРАНЯЕМ ID СООБЩЕНИЯ ДЛЯ КАРТОЧЕК
    if (data.ok && payload._uid) {
      const saved = getWithTTL(payload._uid);
      if (saved) {
        saved.messageId = data.result.message_id;
        setWithTTL(payload._uid, saved, 480);
      }
    }

    return data;

  } catch(e) {
    logDebug('sendTelegram error: ' + e.message);
    return { ok: false, error: e.message };
  }
}

function saveSentMessage(chatId, messageId) {
  const key = `sent_msgs_${chatId}`;
  const arr = getWithTTL(key) || [];

  // 🔥 УДАЛЯЕМ САМЫЕ СТАРЫЕ, ЕСЛИ ПЕРЕПОЛНЕНИЕ
  if (arr.length >= 100) arr.shift();

  arr.push({ chat_id: chatId, message_id: messageId });
  setWithTTL(key, arr, 1440);
}

function clearChat(chatId) {
  const msgs = getWithTTL(`sent_msgs_${chatId}`) || [];
  if (msgs.length === 0) {
    sendMessage('Нет сообщений для очистки', null, chatId);
    return;
  }

  const maxDeletes = Math.min(20, msgs.length);
  let deleted = 0;

  sendMessage(`🧹 Очищаю чат: ${msgs.length} сообщений...`, null, chatId);

  for (let i = 0; i < maxDeletes; i++) {
    const m = msgs[i];
    try {
      UrlFetchApp.fetch(`https://api.telegram.org/bot${CONFIG.TOKEN}/deleteMessage`, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({
          chat_id: m.chat_id,
          message_id: m.message_id
        }),
        muteHttpExceptions: true
      });
      deleted++;
      Utilities.sleep(100);
    } catch(e) {
      logDebug(`Delete skipped (likely >48h): ${m.message_id}`);
    }
  }

  // Обновляем список оставшихся сообщений
  const remaining = msgs.slice(maxDeletes);
  if (remaining.length > 0) {
    setWithTTL(`sent_msgs_${chatId}`, remaining, 1440);
    sendMessage(`✅ Удалено: ${deleted} из ${msgs.length}\nОсталось: ${remaining.length}`, null, chatId);
  } else {
    scriptProps.deleteProperty(`sent_msgs_${chatId}`);
    scriptProps.deleteProperty(`ttl_sent_msgs_${chatId}`);
    sendMessage(`✅ Чат полностью очищен! Удалено: ${deleted} сообщений`, null, chatId);
  }
}

function sendMessage(
  text,
  keyboard = null,
  chatId = CONFIG.CHAT_ID,
  mode = CONFIG.SEND_MODE.FAST,
  uid = null,
  opts = {}
) {
  const payload = {
    chat_id: chatId,
    text: text,
    disable_web_page_preview: true,
    ...(opts.markdown !== false && { parse_mode: 'MarkdownV2' }),
    ...(keyboard && { reply_markup: keyboard }),
    ...(uid && { _uid: uid })
  };

  if (mode === CONFIG.SEND_MODE.QUEUE) {
    addToQueue(payload);
  } else {
    try {
      sendTelegram(payload);
    } catch (e) {
      addToQueue(payload);
    }
  }
}

// 🔥 ПЕРЕНОС ОЧЕРЕДИ TELEGRAM В CACHESERVICE
function addToQueue(payload) {
  const cacheKey = 'tg_queue_cache';

  try {
    // Пробуем CacheService
    const cached = CACHE.get(cacheKey);
    let queue = cached ? JSON.parse(cached) : [];
    queue.push(payload);
    CACHE.put(cacheKey, JSON.stringify(queue), 3600); // 1 час

    // Дублируем в ScriptProperties для надежности
    const propQueue = getWithTTL('tg_queue') || [];
    propQueue.push(payload);
    setWithTTL('tg_queue', propQueue, 60); // 1 час

    console.log(`📨 Сообщение добавлено в очередь (кэш). Длина очереди: ${queue.length}`);

  } catch (error) {
    // Fallback на ScriptProperties
    console.warn('CacheService для очереди недоступен, использую ScriptProperties');
    const queue = getWithTTL('tg_queue') || [];
    queue.push(payload);
    setWithTTL('tg_queue', queue, 60);
  }
}

// 🔥 БЕЗОПАСНАЯ processQueueFast БЕЗ ПОТЕРИ СООБЩЕНИЙ
function processQueueFast() {
  if (!lockService.tryLock(5000)) {
    console.log('⏳ Очередь уже обрабатывается другим процессом');
    return;
  }

  try {
    // 1. Получаем очередь из кэша (приоритет) или Properties
    let queue = [];
    let queueSource = 'cache';

    try {
      const cached = CACHE.get('tg_queue_cache');
      if (cached) {
        queue = JSON.parse(cached);
      }
    } catch (e) {
      console.warn('Не удалось получить очередь из CacheService:', e);
    }

    // Если кэш пуст, пробуем Properties
    if (!queue.length) {
      queue = getWithTTL('tg_queue') || [];
      queueSource = 'properties';
    }

    // Защита от не-массивов
    if (!Array.isArray(queue)) {
      console.error('❌ Очередь не является массивом:', typeof queue);
      // Сбрасываем поврежденные данные
      if (queueSource === 'cache') {
        CACHE.remove('tg_queue_cache');
      } else {
        scriptProps.deleteProperty('tg_queue');
        scriptProps.deleteProperty('ttl_tg_queue');
      }
      return;
    }

    if (!queue.length) {
      return;
    }

    console.log(`📨 Начало обработки очереди: ${queue.length} сообщений (источник: ${queueSource})`);

    // 2. Сохраняем копию для безопасности
    const originalQueue = [...queue];
    const maxMessages = Math.min(20, queue.length); // Ограничиваем за один запуск
    const toProcess = queue.slice(0, maxMessages);
    const remainingInQueue = queue.slice(maxMessages);

    let failed = [];
    let sentCount = 0;
    let errorCount = 0;

    // 3. Обрабатываем сообщения
    for (let i = 0; i < toProcess.length; i++) {
      const msg = toProcess[i];

      try {
        // 🔥 ДИАГНОСТИКА: логируем текст сообщения перед отправкой
        if (CONFIG.DEBUG && i < 3) { // Только первые 3 сообщения
          console.log(`🔍 Проверка сообщения ${i+1}:`,
            msg.text ? msg.text.substring(0, 100) : 'Нет текста');
        }

        // 🔥 ПРОБНЫЙ РЕЖИМ: если DEBUG, проверяем Markdown
        if (CONFIG.DEBUG && msg.parse_mode === 'MarkdownV2') {
          const testText = msg.text || '';
          const unsafePatterns = [
            /\[[^\]]*$/m,  // незакрытая скобка
            /\([^\)]*$/m,  // незакрытая круглая скобка
            /(?<!\\)\./,   // неэкранированная точка
            /(?<!\\)\-/,   // неэкранированный минус
            /(?<!\\)\+/,   // неэкранированный плюс
            /(?<!\\)=/,    // неэкранированный знак равенства
          ];

          for (const pattern of unsafePatterns) {
            if (pattern.test(testText)) {
              console.warn(`⚠️ Обнаружен опасный символ в Markdown: ${pattern}`);
              console.log(`   Текст: ${testText.substring(0, 200)}`);
              // Автоматически экранируем опасные символы
              msg.text = testText.replace(pattern, match => '\\' + match);
            }
          }
        }



        // 🔥 Мягкий sleep между сообщениями (80мс)
        if (i > 0) Utilities.sleep(80);

        const data = sendTelegram(msg);

        if (!data.ok) {
          // 🔥 Анализ ошибки
          console.warn(`⚠️ Ошибка отправки: ${data.description || 'Unknown error'}`);

          // 429 Too Many Requests - прерываем всё, сохраняем всю очередь
          if (data.error_code === 429) {
            console.warn('⚠️ Достигнут лимит Telegram. Сохраняем всю очередь.');
            // Возвращаем ВСЁ в очередь (и обработанные тоже!)
            failed = failed.concat(toProcess.slice(i));
            break;
          }

          // Bad Request (Markdown/chat) - удаляем навсегда, НЕ возвращаем
          if (data.description && (
            data.description.includes('bad request') ||
            data.description.includes('chat not found') ||
            data.description.includes('parse_mode') ||
            data.description.includes('Markdown')
          )) {
            console.error(`❌ Фатальная ошибка, удаляем сообщение: ${data.description}`);
            continue;
          }

          // Временная ошибка - пробуем до 3 раз
          msg._tries = (msg._tries || 0) + 1;
          if (msg._tries < 3) {
            failed.push(msg);
          } else {
            console.warn(`❌ Сообщение удалено после 3 неудачных попыток`);
          }

        } else {
          // Успешная отправка
          sentCount++;

          // 🔥 Сохраняем ID сообщения если нужно
          if (msg._uid && data.result && data.result.message_id) {
            const saved = getWithTTL(msg._uid);
            if (saved) {
              saved.messageId = data.result.message_id;
              setWithTTL(msg._uid, saved, 480);
            }
          }
        }

      } catch (e) {
        console.error(`❌ Сбой системы при отправке: ${e.message}`);
        errorCount++;
        // При системной ошибке сохраняем сообщение
        msg._tries = (msg._tries || 0) + 1;
        if (msg._tries < 3) failed.push(msg);
      }
    }

    // 4. Формируем финальную очередь (ошибки + необработанные)
    const finalQueue = failed.concat(remainingInQueue);

    // 5. Сохраняем в оба хранилища для надежности
    if (finalQueue.length > 0) {
      console.log(`📊 Сохраняем очередь: ${finalQueue.length} сообщений`);

      try {
        // CacheService (основное)
        CACHE.put('tg_queue_cache', JSON.stringify(finalQueue), 3600);

        // Properties (бэкап)
        scriptProps.setProperty('tg_queue', JSON.stringify(finalQueue));
        scriptProps.setProperty('ttl_tg_queue', String(Date.now() + 3600000));
      } catch (e) {
        console.error('❌ Ошибка сохранения очереди:', e);
      }
    } else {
      // Очередь пуста - очищаем всё
      console.log('✅ Очередь полностью обработана, очищаем хранилища');

      CACHE.remove('tg_queue_cache');
      scriptProps.deleteProperty('tg_queue');
      scriptProps.deleteProperty('ttl_tg_queue');
    }

    // 6. Логируем результат
    console.log(`📊 Итог обработки очереди:
    • Отправлено: ${sentCount}
    • Ошибок: ${errorCount}
    • Сохранено в очередь: ${finalQueue.length}
    • Удалено навсегда: ${toProcess.length - sentCount - failed.length}`);

    // 🔥 В DEBUG режиме отправляем отчет раз в 10 раз
    if (CONFIG.DEBUG && Math.random() < 0.1) {
      const report = `📊 Очередь Telegram:
• Всего было: ${originalQueue.length}
• Отправлено: ${sentCount}
• Осталось: ${finalQueue.length}
• Ошибок: ${errorCount}`;

      sendMessage(report, null, CONFIG.CHAT_ID, CONFIG.SEND_MODE.QUEUE, null, { markdown: false });
    }

  } catch (error) {
    console.error('❌ Критическая ошибка в processQueueFast:', error);

    // 🔥 В случае общей ошибки сохраняем очередь в Properties (более надежно)
    try {
      const emergencyQueue = getWithTTL('tg_queue') || [];
      scriptProps.setProperty('tg_queue_emergency', JSON.stringify(emergencyQueue));
      scriptProps.setProperty('ttl_tg_queue_emergency', String(Date.now() + 7200000));
    } catch (e) {
      // Последняя попытка
    }

  } finally {
    try {
      lockService.releaseLock();
    } catch (e) {
      console.error('Не удалось освободить блокировку:', e);
    }
  }
}

// ===================== УТИЛИТЫ =====================
// 🔥 ОБНОВЛЕННЫЙ setWithTTL С ПРИОРИТЕТАМИ
