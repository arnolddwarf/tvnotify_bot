import { Telegraf, Markup } from 'telegraf';
import fetch from 'node-fetch';
import cron from 'node-cron';
import { MongoClient } from 'mongodb';

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN_OTHER;
const TVDB_API_KEY = process.env.TVDB_API_KEY;
const CHAT_ID = process.env.CHAT_ID_OTHER; // ID del chat donde quieres enviar los mensajes
const MONGODB_URI = process.env.MONGO_URI; // URI de tu base de datos MongoDB

const bot = new Telegraf(TELEGRAM_TOKEN);
const client = new MongoClient(MONGODB_URI);

let db;
let seriesCollection;
let reactionsCollection;


// Conectar a la base de datos
client.connect().then(() => {
  db = client.db('telegram_bot_db');
  seriesCollection = db.collection('series');
  reactionsCollection = db.collection('reactions');
  console.log('Connected to MongoDB');
});



// Lista de series
const lastNotifiedEpisodes = {}; // Para almacenar el último episodio notificado por serie

// Función para obtener episodios válidos de una temporada
const fetchValidEpisodes = async (seriesId, season) => {
  const episodesUrl = `https://api.thetvdb.com/series/${seriesId}/episodes/query?airedSeason=${season}&page=1`;
  const episodesResponse = await fetch(episodesUrl, {
    headers: {
      Authorization: `Bearer ${TVDB_API_KEY}`,
    },
  });
  const episodesData = await episodesResponse.json();
  if (!episodesData.data || episodesData.data.length === 0) {
    console.error(`No episodes found for season ${season}`);
    return [];
  }
  // Filtrar episodios que no sean TBA
  return episodesData.data.filter((ep) => ep.episodeName && ep.overview && ep.filename);
};

// Función para obtener información del último episodio de una serie
const fetchLatestEpisode = async (seriesId) => {
  const url = `https://api.thetvdb.com/series/${seriesId}/episodes/summary`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TVDB_API_KEY}`,
      },
    });
    const data = await response.json();
    if (!data.data || !data.data.airedSeasons || data.data.airedSeasons.length === 0) {
      console.error('No aired seasons found');
      return null;
    }

    // Buscar episodios válidos desde la última temporada hacia atrás
    while (data.data.airedSeasons.length > 0) {
      const latestSeason = data.data.airedSeasons.pop();
      const validEpisodes = await fetchValidEpisodes(seriesId, latestSeason);
      if (validEpisodes.length > 0) {
        return validEpisodes.pop(); // Obtener el último episodio válido de la temporada
      }
    }
    console.error('No valid episodes found in any season');
    return null;
  } catch (error) {
    console.error('Error fetching latest episode:', error);
    return null;
  }
};

// Función para obtener el nombre de una serie
const fetchSeriesName = async (seriesId) => {
  const url = `https://api.thetvdb.com/series/${seriesId}`;
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TVDB_API_KEY}`,
      },
    });
    const data = await response.json();
    if (data.data) {
      return data.data.seriesName;
    } else {
      console.error(`No series found with ID ${seriesId}`);
      return 'Unknown Series';
    }
  } catch (error) {
    console.error('Error fetching series name:', error);
    return 'Unknown Series';
  }
};

// Función para obtener las reacciones de un episodio
const getReactions = async (episodeId) => {
  const reactions = await reactionsCollection.aggregate([
    { $match: { episodeId } },
    { $group: { _id: '$reaction', count: { $sum: 1 } } },
  ]).toArray();

  const reactionCounts = {
    like: 0,
    love: 0,
    angry: 0,
  };

  reactions.forEach(({ _id, count }) => {
    reactionCounts[_id] = count;
  });

  return reactionCounts;
};

// Función para enviar la notificación del último episodio
const sendLatestEpisodeNotification = async (episode, chatId) => {
  if (!episode) {
    console.error('No episode data provided');
    return;
  }

  const { id, episodeName, airedEpisodeNumber, airedSeason, overview, filename } = episode;
  const thumbnail = `https://www.thetvdb.com/banners/${filename}`;
  const message = `
📺 Title: ${episodeName}
📅 Season: S${String(airedSeason).padStart(2, '0')}E${String(airedEpisodeNumber).padStart(2, '0')}
📝 Description: ${overview}
  `;

  const reactions = await getReactions(id);

  await bot.telegram.sendPhoto(chatId, thumbnail, {
    caption: message,
    reply_markup: {
      inline_keyboard: [
        [
          { text: `👍 ${reactions.like || 0}`, callback_data: `like_${id}` },
          { text: `❤️ ${reactions.love || 0}`, callback_data: `love_${id}` },
          { text: `😡 ${reactions.angry || 0}`, callback_data: `angry_${id}` },
        ],
      ],
    },
  });
};

// Función para verificar y notificar un nuevo episodio para una serie específica
const checkForNewEpisode = async (seriesId) => {
  const latestEpisode = await fetchLatestEpisode(seriesId);
  if (latestEpisode && latestEpisode.id !== lastNotifiedEpisodes[seriesId]) {
    await sendLatestEpisodeNotification(latestEpisode, CHAT_ID);
    lastNotifiedEpisodes[seriesId] = latestEpisode.id;
  }
};

// Verificar cada minuto si hay un nuevo episodio en cada serie de la lista
cron.schedule('* * * * *', async () => {
  const seriesList = await seriesCollection.find().toArray();
  seriesList.forEach((series) => {
    checkForNewEpisode(series.seriesId);
  });
});

bot.start((ctx) => ctx.reply('Welcome! Add a series using /add_series <series_id>.'));

// Comando para agregar series
bot.command('add_series', async (ctx) => {
  const seriesId = ctx.message.text.split(' ')[1];
  if (seriesId && !(await seriesCollection.findOne({ seriesId }))) {
    await seriesCollection.insertOne({ seriesId });
    ctx.reply(`Series with ID ${seriesId} added.`);
  } else {
    ctx.reply('Please provide a valid series ID or the series is already added.');
  }
});

// Comando para enviar la información del último episodio de una serie específica
bot.command('latest_episode', async (ctx) => {
  const seriesId = ctx.message.text.split(' ')[1];
  const latestEpisode = await fetchLatestEpisode(seriesId);
  if (latestEpisode) {
    await sendLatestEpisodeNotification(latestEpisode, ctx.chat.id);
  } else {
    ctx.reply('Error fetching latest episode.');
  }
});

// Comando para listar las series
bot.command('list_series', async (ctx) => {
  const seriesList = await seriesCollection.find().toArray();
  if (seriesList.length === 0) {
    ctx.reply('No series added.');
  } else {
    const buttons = [];
    for (const series of seriesList) {
      const seriesName = await fetchSeriesName(series.seriesId);
      buttons.push(Markup.button.callback(seriesName, `series_${series.seriesId}`));
    }
    await ctx.reply('Series List:', Markup.inlineKeyboard(buttons, { columns: 1 }));
  }
});

// Manejar acciones de botones de series
bot.action(/series_(.+)/, async (ctx) => {
  const seriesId = ctx.match[1];
  const seriesName = await fetchSeriesName(seriesId);
  console.log(`Selected series: ${seriesName} (${seriesId})`); // Log de depuración
  await ctx.editMessageText(`Selected series: ${seriesName}`, {
    reply_markup: {
      inline_keyboard: [
        [Markup.button.callback('❌ Remove', `remove_${seriesId}`)],
        [Markup.button.callback('🔙 Back to list', 'back_to_list')],
      ],
    },
  });
});

/// Manejar la acción de eliminar serie
bot.action(/remove_(.+)/, async (ctx) => {
  const seriesId = ctx.match[1];
  console.log(`Removing series: ${seriesId}`);
  await seriesCollection.deleteOne({ seriesId });
  await ctx.editMessageText(`Series with ID ${seriesId} removed.`, {
    reply_markup: {
      inline_keyboard: [
        [Markup.button.callback('🔙 Back to list', 'back_to_list')],
      ],
    },
  });
});

// Manejar la acción de volver a la lista de series
bot.action('back_to_list', async (ctx) => {
  const seriesList = await seriesCollection.find().toArray();
  if (seriesList.length === 0) {
    ctx.reply('No series added.');
  } else {
    const buttons = [];
    for (const series of seriesList) {
      const seriesName = await fetchSeriesName(series.seriesId);
      buttons.push(Markup.button.callback(seriesName, `series_${series.seriesId}`));
    }
    await ctx.editMessageText('Series List:', {
      reply_markup: {
        inline_keyboard: buttons.map((button) => [button]), // Formatear los botones en una columna
      },
    });
  }
});





// Manejar reacciones
bot.action(/(like|love|angry)_(.+)/, async (ctx) => {
  const reaction = ctx.match[1];
  const episodeId = ctx.match[2];
  const userId = ctx.from.id;

  const existingReaction = await reactionsCollection.findOne({ episodeId, userId });

  if (existingReaction) {
    if (existingReaction.reaction !== reaction) {
      await reactionsCollection.updateOne(
        { episodeId, userId },
        { $set: { reaction } }
      );
    } else {
      return; // Si la reacción es la misma, no hacer nada
    }
  } else {
    await reactionsCollection.insertOne({ episodeId, userId, reaction });
  }

  const reactions = await getReactions(episodeId);

  const newReplyMarkup = {
    inline_keyboard: [
      [
        { text: `👍 ${reactions.like || 0}`, callback_data: `like_${episodeId}` },
        { text: `❤️ ${reactions.love || 0}`, callback_data: `love_${episodeId}` },
        { text: `😡 ${reactions.angry || 0}`, callback_data: `angry_${episodeId}` },
      ],
    ],
  };

  try {
    await ctx.editMessageReplyMarkup(newReplyMarkup);
  } catch (error) {
    console.error('Error updating reply markup:', error);
  }

  ctx.answerCbQuery(`You reacted with ${reaction}`, { show_alert: true });
});

bot.launch().then(() => {
  console.log('Bot is running...');
});