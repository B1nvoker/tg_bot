function doPost(e) {
  try {
    const update = JSON.parse(e.postData.contents);

    // 1. Обработка кнопок (Callback)
    if (update.callback_query) return handleCallback(update.callback_query);

    // 2. Обработка сообщений
    if (!update.message) return;
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    const userName = msg.from.first_name || 'Аноним'; // 🔥 Берем имя отправителя

    if (msg.photo) return handleVamPhoto(msg);
    if (text.startsWith('/')) return handleCommand(text, chatId);

    // 🔥 Передаем userName в диалоги
    if (handleDialogs(text, chatId, userName)) return;

  } catch (err) {
    logDebug('doPost Error: ' + err);
    console.error(err);
  }
}

function handleCommand(text, chatId) {
  const cmd = text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
  switch (cmd) {
    case '/give_money': setWithTTL(`gm_step_${chatId}`, 'ask_sum', 30);
      sendMessage('💸 Сколько дал денег?', null, chatId, CONFIG.SEND_MODE.FAST, null, { markdown: false });
    break;
    case '/buy_usd': setWithTTL(`buyusd_step_${chatId}`, 'ask_byn', 30);
      sendMessage('Сколько дал BYN?', null, chatId);
    break;
    case '/mapping': buildRoute(chatId);
    break;
    case '/vamexpress': setWithTTL(`vam_step_${chatId}`, 'vam_wait_photo', 30);
      sendMessage('📸 Пришлите фото отчёта ВамЭкспресс', null, chatId);
    break;
    case '/money': sendMoneyBalance(chatId);
    break;
    case '/clear': clearChat(chatId);
    break;
    case '/cancel': clearStates(chatId);
      sendMessage('❌ Отменено', null, chatId, CONFIG.SEND_MODE.FAST, null, { markdown: false });
    break;
  }
}

// 🔥 ОБНОВЛЕННЫЙ handleCallback С СОХРАНЕНИЕМ ИМЕНИ
function handleCallback(cb) {
  // 🔥 Анти-даблклик: мгновенно отвечаем Telegram
  try { answerCb(cb.id, "⏳ Секунду..."); } catch(e) {}

  if (!userLockService.tryLock(2000)) return;

  try {
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data;
    const userName = cb.from.first_name || 'Аноним';

  // ================= DELIVERED =================
  if (data.startsWith('delivered_')) {
        const uid = data.split('_')[1];
        const saved = getWithTTL(uid);

        if (!saved) {
          return answerCb(cb.id, '❌ Ошибка: Данные заказа устарели. Нажмите кнопку заново.');
        }

        const changedSum = getWithTTL(`real_price_${uid}`);
        const originalSum = parsePrice(saved.totalPrice);
        let sum = changedSum || saved.totalPrice;
    const isCash = CONFIG.PAYMENT_TYPES.CASH.includes(String(saved.payment).toLowerCase());

    if (changedSum && Number(changedSum) !== Number(originalSum)) {
      writeReport(
        '',
        '',
        'Изм. суммы',
        `->${saved.orderNumbers} (было ${formatPriceForDisplay(originalSum)}, стало ${formatPriceForDisplay(changedSum)})`,
        userName
      );
    }

    writeReport(isCash ? sum : '', '', isCash ? 'Продажа' : `Продажа ${saved.payment}`, saved.orderNumbers, userName);

    saved.orderNumbers.split(',').forEach(num => updateStatusByOrderNum(num.trim(), 'Продан'));

    // 🔥 ИСПРАВЛЕНО: единый вызов вместо двух отдельных
    editMessageFull(
      chatId,
      msgId,
      `✅ Заказ ${mdSafe(saved.orderNumbers)} доставлен (исп. ${userName})`,
      null,
      false
    );

    clearStates(chatId, uid);
    return answerCb(cb.id, '');
  }

  // ================= PRICE CHANGE =================
  if (data.startsWith('pricechange_')) {
    const uid = data.split('_')[1];

    if (getWithTTL(`real_price_${uid}`)) {
      return answerCb(cb.id, '⚠️ Цена уже была изменена ранее');
    }

    if (getWithTTL(`price_step_${chatId}`)) {
      return answerCb(cb.id, '❌ Вы уже вводите цену для другого заказа');
    }

    setWithTTL(`price_step_${chatId}`, uid, 30);
    editMessageReplyMarkup(chatId, msgId, { inline_keyboard: [] });
    sendMessage(`💰 Введите реальную сумму для заказа ${getWithTTL(uid).orderNumbers}`, null, chatId);
    return answerCb(cb.id, '');
  }

  // ================= NOT DELIVERED / NOT SENT =================
  if (data.startsWith('notdelivered_') || data.startsWith('notsent_')) {
    const uid = data.split('_')[1];
    const saved = getWithTTL(uid);
    if (!saved) return answerCb(cb.id, 'Устарело');

    const reportLabel = data.includes('notdelivered')
      ? 'Не доставлен'
      : 'Не отправлен';

    writeReport('', '', reportLabel, saved.orderNumbers, userName);

    saved.orderNumbers.split(',').forEach(num => {
      updateStatusByOrderNum(num.trim(), 'Не продан');
    });

    // 🔥 ИСПРАВЛЕНО: единый вызов
    editMessageFull(
      chatId,
      msgId,
      `❌ Заказ ${saved.orderNumbers} → ${reportLabel}`,
      { inline_keyboard: [] }, // Убираем кнопки
      false
    );

    clearStates(chatId, uid);
    return answerCb(cb.id, '');
  }

  // ================= ROUTE ADD =================
  if (data.startsWith('routeadd_')) {
    const uid = data.split('_')[1];
    const saved = getWithTTL(uid);
    if (!saved) return answerCb(cb.id, 'Устарело');

    const key = getRouteKey(chatId);
    const route = getWithTTL(key) || [];

    if (!route.includes(saved.address)) {
      route.push(saved.address);
      setWithTTL(key, route, 720);

      const markup = cb.message.reply_markup;
      markup.inline_keyboard.forEach(row => row.forEach(btn => {
        if (btn.callback_data.includes('routeadd_')) {
          btn.text = '✔️ В списке';
          btn.callback_data = 'noop';
        }
      }));
      editMessageReplyMarkup(chatId, msgId, markup);
      return answerCb(cb.id, '📍 Адрес добавлен в общий маршрут');
    } else {
      return answerCb(cb.id, 'Уже в списке');
    }
  }

  // ================= CLEAR ROUTE =================
  if (data === 'clear_route_confirm') {
    const key = getRouteKey(chatId);
    scriptProps.deleteProperty(key);
    scriptProps.deleteProperty(`ttl_${key}`);

    try {
      CACHE.remove(`cache_${key}`);
      CACHE.remove(key);
    } catch (e) {
      console.warn('Не удалось очистить кэш маршрута:', e);
    }

    editMessageText(chatId, msgId, '✅ *Общий маршрут полностью очищен*', true);
    return answerCb(cb.id, 'Маршрут удален');
  }

  // ================= VAM EXPRESS =================
  if (data.startsWith('vam_')) {
    const uid = data.replace('vam_', '');
    const saved = getWithTTL(uid);
    if (!saved) return answerCb(cb.id, 'Устарело');

    updateOrderStatus(saved.rows, 'ВамЭкспресс');
    writeReport('', '', 'Отправили на ВамЭкспресс', saved.orderNumbers, userName);
    appendVamExpressGrouped(saved.fullData);

    // 🔥 ИСПРАВЛЕНО: единый вызов
    editMessageFull(
      chatId,
      msgId,
      `📦 Заказ ${saved.orderNumbers} уехал на ВамЭкспресс`,
      { inline_keyboard: [] },
      false
    );

    return answerCb(cb.id, '');
  }

  // ================= AUTOLIGHT =================
  if (data.startsWith('autolight_')) {
    const uid = data.replace('autolight_', '');
    const saved = getWithTTL(uid);
    if (!saved) return answerCb(cb.id, 'Устарело');

    updateOrderStatus(saved.rows, 'Автолайт');
    writeReport('', '', 'Отправили на Автолайт', saved.orderNumbers, userName);

    // 🔥 ИСПРАВЛЕНО: единый вызов
    editMessageFull(
      chatId,
      msgId,
      `🚛 Заказ ${saved.orderNumbers} уехал на Автолайт`,
      { inline_keyboard: [] },
      false
    );

    return answerCb(cb.id, '');
  }

  // ================= GIVE MONEY SUPPLIER =================
// В функции handleCallback найти блок GIVE MONEY SUPPLIER:
if (data.startsWith('gm_supplier_')) {
  const sup = data.replace('gm_supplier_', '');
  const sum = Number(getWithTTL(`gm_sum_${chatId}`));

    // 🔥 ЕСЛИ ВЫБРАЛИ "ДРУГОЕ" — СПРАШИВАЕМ КОМУ
    if (sup === 'Другое') {
      setWithTTL(`gm_step_${chatId}`, 'ask_other_name', 30);
      setWithTTL(`gm_sum_${chatId}`, sum, 30);

      editMessageText(chatId, msgId, `✏️ Кому именно дал ${sum}?`, false);
      editMessageReplyMarkup(chatId, msgId, { inline_keyboard: [] });

      return answerCb(cb.id, '');
    }

    // ===== ОБЫЧНЫЙ СЦЕНАРИЙ =====
    // Упрощенная версия БЕЗ USD логики
    writeReport(
      -sum,
      '',
      'Дать денег',
      sup || 'Без поставщика',
      userName
    );

    // 🔥 если выбран поставщик и это Технобай
    if (sup && normalizeSupplierName(sup) === normalizeSupplierName('Технобай')) {
      syncWithTechnoBay(
        getToday(),
        'Выплата (бот)',
        -sum,
        userName
      );
    }

    editMessageText(chatId, msgId, `✅ Записано: Дал ${sum} BYN → ${sup}`, false);
    editMessageReplyMarkup(chatId, msgId, { inline_keyboard: [] });
    clearStates(chatId);
    return answerCb(cb.id, '');
  }

  // ================= EXTRA DONE / NOT DONE =================
  if (data.startsWith('extra_done_') || data.startsWith('extra_notdone_')) {
    const isDone = data.startsWith('extra_done_');
    const uid = data.split('_').slice(2).join('_');
    const task = getWithTTL(uid);
    if (!task) return answerCb(cb.id, 'Устарело');

    const statusText = isDone ? 'Сделано' : 'Не сделано';
    writeReport('', '', 'Точка', `${statusText} -> ${task.todo}`, userName);

    // 🔥 ИСПРАВЛЕНО: единый вызов с Markdown
    editMessageFull(
      chatId,
      msgId,
      `${isDone ? '✅' : '❌'} *${task.todo}* — ${statusText}`,
      { inline_keyboard: [] },
      true // Markdown включен
    );

    // 🔥 ОЧИЩАЕМ КЭШ ЗАДАЧИ
    scriptProps.deleteProperty(uid);
    scriptProps.deleteProperty(`ttl_${uid}`);
    return answerCb(cb.id, statusText);
  }

  // ================= EXTRA MONEY (ДАЛ / НЕ ДАЛ) =================
  if (data.startsWith('extra_money_')) {
    const uid = data.split('_').slice(2).join('_');
    const task = getWithTTL(uid);
    if (!task) return answerCb(cb.id, 'Устарело');

    const sum = Math.abs(Number(task.sum) || 0);
    const isUsd = String(task.cur).toUpperCase() === 'USD';

    writeReport(
      isUsd ? '' : -sum,
      isUsd ? -sum : '',
      task.art || 'Дать денег',
      task.todo || task.sup,
      userName
    );

    // 🔥 если указан поставщик и это Технобай
    if (task.sup && normalizeSupplierName(task.sup) === normalizeSupplierName('Технобай')) {
      syncWithTechnoBay(
        getToday(),
        task.todo || 'Выплата',
        -sum,
        userName
      );
    }

    // 🔥 ИСПРАВЛЕНО: единый вызов
    editMessageFull(
      chatId,
      msgId,
      `✅ Дал денег: ${task.todo || task.sup} (${sum} ${task.cur})`,
      { inline_keyboard: [] },
      false
    );

    // 🔥 ОЧИЩАЕМ КЭШ ЗАДАЧИ
    scriptProps.deleteProperty(uid);
    scriptProps.deleteProperty(`ttl_${uid}`);
    return answerCb(cb.id, 'Записано');
  }

  if (data.startsWith('extra_nomoney_')) {
    const uid = data.split('_').slice(2).join('_');
    const task = getWithTTL(uid);
    if (!task) return answerCb(cb.id, 'Устарело');

    writeReport('', '', task.art || 'Дать денег', `Не дал -> ${task.todo || task.sup}`, userName);

    // 🔥 ИСПРАВЛЕНО: единый вызов с Markdown
    editMessageFull(
      chatId,
      msgId,
      `❌ *${task.todo || task.sup}* — Деньги не давал`,
      { inline_keyboard: [] },
      true // Markdown включен
    );

    // 🔥 ОЧИЩАЕМ КЭШ ЗАДАЧИ
    scriptProps.deleteProperty(uid);
    scriptProps.deleteProperty(`ttl_${uid}`);
    return answerCb(cb.id, 'Отменено');
  }

  // ================= EXTRA CHANGE SUM (ИЗМЕНЕНИЕ СУММЫ) =================
  if (data.startsWith('extra_changesum_')) {
    const uid = data.split('_').slice(2).join('_');

    // 🔥 ЗАЩИТА ОТ ПОВТОРНОГО НАЖАТИЯ
    if (getWithTTL(`extra_edit_sum_${chatId}`)) {
      return answerCb(cb.id, '⏳ Уже жду сумму');
    }

    const task = getWithTTL(uid);
    if (!task) return answerCb(cb.id, 'Устарело');

    setWithTTL(`extra_edit_sum_${chatId}`, uid, 5); // Состояние ожидания суммы на 5 мин
    sendMessage(`✏️ Введите новую сумму для:\n*${mdSafe(task.todo || task.sup)}*`, null, chatId);
    return answerCb(cb.id, 'Жду сумму...');
  }

  // ================= UNKNOWN COMMAND =================
  logDebug(`Unknown callback [chat ${chatId}]: ${data}`);

  return answerCb(cb.id, 'Неизвестная команда');
  } finally {
      try { userLockService.releaseLock(); } catch(e) {}
    }
}

function handleDialogs(text, chatId, userName = 'Пользователь') {

  if (text.startsWith('/')) return false;

// ================= VAM EXPRESS SUM (ПЕРВЫМ!) =================
  if (getWithTTL(`vam_step_${chatId}`) === 'vam_wait_sum') {
    const val = parsePrice(text);

    if (isNaN(val) || val <= 0) {
      sendMessage('❌ Введите корректную сумму (число)', null, chatId);
      return true;
    }

    try {
      // Показываем пользователю, что мы начали сверку (чтобы не было тишины)
      sendMessage('⏳ Сверяю данные, подождите...', null, chatId, CONFIG.SEND_MODE.FAST, null, { markdown: false });

       // 🔥 ПЕРЕДАЕМ userName (который теперь приходит в аргументы handleDialogs)
      const res = reconcileVamExpress(val, userName);

      const successMsg = `🧾 Сверка завершена!\n` +
                        `• Найдено в чеке: ${res.matchedSum} руб\n` +
                        `• Введено вами: ${res.realSum} руб\n` +
                        `• Заказов обработано: ${res.orders.length}\n` +
                        `• Выполнил: ${userName}\n\n` +
                        `${res.matchedSum === res.realSum ? '✅ Суммы сошлись' : '⚠️ Есть расхождения'}`;

      sendMessage(successMsg, null, chatId, CONFIG.SEND_MODE.FAST, null, { markdown: false });

    } catch (e) {
      console.error('Ошибка сверки:', e);
      sendMessage(`❌ Ошибка сверки: ${e.message}`, null, chatId, CONFIG.SEND_MODE.FAST, null, { markdown: false });
    }

    scriptProps.deleteProperty(`vam_step_${chatId}`);
    scriptProps.deleteProperty(`ttl_vam_step_${chatId}`);
    return true;
  }

    // 🔥 ЗАЩИТА: не обрабатываем команды
    if (text.startsWith('/')) return false;

    // 1. ПЕРЕХВАТ ИЗМЕНЕНИЯ СУММЫ ДОП. ДЕЛ
    const editUid = getWithTTL(`extra_edit_sum_${chatId}`);

    if (editUid) {
      if (!/[\d,.]/.test(text)) {
        sendMessage('❌ Введите число', null, chatId);
        return true;
      }
    const val = parsePrice(text);
    const task = getWithTTL(editUid);
    if (!task) {
      scriptProps.deleteProperty(`extra_edit_sum_${chatId}`);
      return false;
    }
    if (isNaN(val) || val <= 0) {
      sendMessage('❌ Введите корректное число больше 0', null, chatId);
      return true;
    }

    const cur = String(task.cur || 'BYN').toUpperCase();
    const isUsd = cur === 'USD';

    // Записываем в отчет
    writeReport(
      isUsd ? '' : -val,
      isUsd ? -val : '',
      task.art || 'Дать денег',
      `Изм. суммы -> ${task.todo || task.sup} (было ${task.sum}, стало ${val})`, userName); // 🔥 ДОБАВЛЕНО userName

    // Если Технобай - синхронизируем лист ТБ
    if (!task.tbWritten && normalizeSupplierName(task.sup) === normalizeSupplierName('Технобай')) {
      syncWithTechnoBay(getToday(), `Изм. суммы: ${task.todo || 'Выплата'}`, -val, userName); // Добавь userName в конец
      task.tbWritten = true;
      setWithTTL(editUid, task, 480);
    }

    // Обновляем оригинальное сообщение (удаляем кнопки)
    if (task.messageId) {
      editMessageText(chatId, task.messageId, `✅ Сумма изменена: *${val} ${cur}* для ${task.todo || task.sup}`, true);
      editMessageReplyMarkup(chatId, task.messageId, { inline_keyboard: [] });
    }

    sendMessage(`✅ Сумма *${val} ${cur}* успешно записана в отчет\.`, null, chatId);

    // 🔥 ОЧИЩАЕМ ОБА КЭША (и состояние диалога, и задачу)
    scriptProps.deleteProperty(`extra_edit_sum_${chatId}`);
    scriptProps.deleteProperty(editUid);
    scriptProps.deleteProperty(`ttl_${editUid}`);
    return true;
  }

  // 2. ПЕРЕХВАТ ИЗМЕНЕНИЯ ЦЕНЫ ЗАКАЗА
  const priceUid = getWithTTL(`price_step_${chatId}`);
  if (priceUid) {
    const val = parsePrice(text);
    if (isNaN(val) || val === 0) {
      sendMessage('Введите корректное число', null, chatId);
      return true;
    }
    setWithTTL(`real_price_${priceUid}`, val, 60);
    scriptProps.deleteProperty(`price_step_${chatId}`);

    const saved = getWithTTL(priceUid);
    if (saved && saved.messageId) {
      const kb = { inline_keyboard: [
        [{ text: `👍 Доставлено (изм. на ${val})`, callback_data: `delivered_${priceUid}` }, { text: '💰 Цена изменена', callback_data: `pricechange_${priceUid}` }],
        [{ text: '❌ Не доставлен', callback_data: `notdelivered_${priceUid}` }],
        [{ text: '➕ В маршрут', callback_data: `routeadd_${priceUid}` }]
      ]};
      editMessageReplyMarkup(chatId, saved.messageId, kb);
    }
    sendMessage(`✅ Сумма ${val} BYN сохранена. Теперь нажмите «Доставлено» в карточке заказа.`,
      null, chatId, CONFIG.SEND_MODE.FAST, null, { markdown: false });
    return true;
  }

  // 4. ШАГИ ДАТЬ ДЕНЕГ (ОСНОВНЫЕ)
  if (getWithTTL(`gm_step_${chatId}`) === 'ask_sum') {
    const val = parsePrice(text);
    setWithTTL(`gm_sum_${chatId}`, val, 30); setWithTTL(`gm_step_${chatId}`, 'choose', 30);
    const kb = { inline_keyboard: [] };
    CONFIG.SUPPLIERS.GIVE_MONEY.forEach((s, i) => {
      if (i % 2 === 0) kb.inline_keyboard.push([{ text: s, callback_data: `gm_supplier_${s}` }]);
      else kb.inline_keyboard[kb.inline_keyboard.length-1].push({ text: s, callback_data: `gm_supplier_${s}` });
    });
    sendMessage(`Кому дал ${val}?`, kb, chatId); return true;
  }

  // 5. ШАГИ ОБМЕНА ВАЛЮТЫ
  const buyStep = getWithTTL(`buyusd_step_${chatId}`);
  if (buyStep === 'ask_byn') {
    const val = parsePrice(text);
    setWithTTL(`buyusd_byn_${chatId}`, val, 30);
    setWithTTL(`buyusd_step_${chatId}`, 'ask_usd', 30);
    sendMessage('Сколько получил USD?', null, chatId);
    return true;
  }
  if (buyStep === 'ask_usd') {
    const val = parsePrice(text);
    const byn = getWithTTL(`buyusd_byn_${chatId}`);
    writeReport(-byn, val, 'Купил баксы', `Курс ${(byn/val).toFixed(4)}`, userName); // 🔥 ДОБАВЛЕНО userName
    scriptProps.deleteProperty(`buyusd_step_${chatId}`);
    scriptProps.deleteProperty(`buyusd_byn_${chatId}`);
    sendMessage('💵 Записано', null, chatId);
    return true;
  }

    // ===== ДАТЬ ДЕНЕГ → ДРУГОЕ =====
  if (getWithTTL(`gm_step_${chatId}`) === 'ask_other_name') {
    const target = text.trim();
    const sum = Number(getWithTTL(`gm_sum_${chatId}`));

    if (!target) {
      sendMessage('❌ Введите, кому именно вы дали деньги', null, chatId);
      return true;
    }

    writeReport(
      -sum,
      '',
      'Дать денег',
      target,
      userName
    );

    sendMessage(
      `✅ Записано:\nДал ${sum} BYN → ${target}`,
      null,
      chatId,
      CONFIG.SEND_MODE.FAST,
      null,
      { markdown: false }
    );

    clearStates(chatId);
    return true;
  }

  return false;
}

// ===================== СИСТЕМНЫЕ ФУНКЦИИ =====================
// 🔥 ОБНОВЛЕННЫЙ writeReport С ИМЕНЕМ ПОЛЬЗОВАТЕЛЯ И ДИНАМИЧЕСКИМИ КОЛОНКАМИ
