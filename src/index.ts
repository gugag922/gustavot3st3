import wppconnect from '@wppconnect-team/wppconnect';
import dotenv from 'dotenv';
import fs from 'fs';
import { AssemblyAI } from 'assemblyai';

import { initializeNewAIChatSession, mainOpenAI } from './service/openai';
import { sendMessagesWithDelay } from './util';
import { mainGoogle } from './service/google';

dotenv.config();

type AIOption = 'GPT' | 'GEMINI';

const messageBufferPerChatId = new Map();
const messageTimeouts = new Map();
const AI_SELECTED: AIOption = (process.env.AI_SELECTED as AIOption) || 'GEMINI';
const MAX_RETRIES = 3;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

if (AI_SELECTED === 'GEMINI' && !process.env.GEMINI_KEY) {
  throw Error(
    'Você precisa colocar uma key do Gemini no .env! Crie uma gratuitamente em https://aistudio.google.com/app/apikey?hl=pt-br'
  );
}

if (
  AI_SELECTED === 'GPT' &&
  (!process.env.OPENAI_KEY || !process.env.OPENAI_ASSISTANT)
) {
  throw Error(
    'Para utilizar o GPT você precisa colocar no .env a sua key da openai e o id do seu assistente.'
  );
}

if (!ASSEMBLYAI_API_KEY) {
  throw Error('Você precisa colocar a sua ASSEMBLYAI_API_KEY no arquivo .env');
}

const clientAssemblyAI = new AssemblyAI({ apiKey: ASSEMBLYAI_API_KEY });

wppconnect
  .create({
    session: 'sessionName',
    catchQR: (base64Qrimg, asciiQR, attempts, urlCode) => {
      console.log('Terminal qrcode: ', asciiQR);
    },
    statusFind: (statusSession, session) => {
      console.log('Status Session: ', statusSession);
      console.log('Session name: ', session);
    },
    headless: 'new' as any,
  })
  .then((client) => {
    start(client);
  })
  .catch((erro) => {
    console.log(erro);
  });

async function start(client: wppconnect.Whatsapp): Promise<void> {
  client.onAnyMessage(async (message) => {
    try {
      // Ignorar mensagens do próprio bot
      if (message.fromMe) {
        return;
      }

      if (
        !message.isGroupMsg &&
        message.chatId !== 'status@broadcast'
      ) {
        const chatId = message.chatId;
        console.log(
          `Mensagem recebida do chatId: ${chatId}, Tipo: ${message.type}, Conteúdo: ${
            message.body ? message.body : 'Conteúdo Multimídia'
          }`
        );

        let messageContent = '';

        // Verificação de tipo e tratamento de erro dentro do bloco try
        try {
          if (message.type === 'ptt' || message.type === 'audio') {
            messageContent = await transcribeAudio(message);
            console.log("Transcrição do áudio:", messageContent);
          } else if (message.type === 'chat') {
            messageContent = message.body;
          } else {
            return; // Ignora mensagens que não sejam texto, áudio ou ptt
          }
        } catch (error) {
          console.error("Erro ao processar áudio:", error);
          messageContent = 'Desculpe, não foi possível processar o áudio.';
        }

        if (AI_SELECTED === 'GPT') {
          await initializeNewAIChatSession(chatId);
        }

        console.log("Enviando para a IA a mensagem:", messageContent);

        messageBufferPerChatId.set(chatId, messageContent);

        if (messageTimeouts.has(chatId)) {
          clearTimeout(messageTimeouts.get(chatId));
        }

        messageTimeouts.set(
          chatId,
          setTimeout(async () => {
            try {
              const currentMessage = messageBufferPerChatId.get(chatId);
              console.log("Buscando mensagem no buffer:", currentMessage);

              let answer = '';

              for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                try {
                  if (AI_SELECTED === 'GPT') {
                    answer = await mainOpenAI({ currentMessage, chatId });
                  } else {
                    answer = await mainGoogle({ currentMessage, chatId });
                  }

                  if (answer.trim() === '') {
                    answer = 'Desculpe, não entendi. Pode repetir?';
                  }
                  break;
                } catch (error) {
                  if (attempt === MAX_RETRIES) {
                    throw error;
                  }
                  console.error(`Tentativa ${attempt} falhou. Tentando novamente...`);
                }
              }

              const messages = splitMessages(answer);
              console.log('Enviando mensagens...');
              await sendMessagesWithDelay({
                client,
                messages,
                targetNumber: message.from,
              });
            } catch (error) {
              console.error('Erro ao processar mensagem:', error);
            } finally {
              messageBufferPerChatId.delete(chatId);
              messageTimeouts.delete(chatId);
            }
          }, 7000)
        );
      }
    } catch (error) {
      console.error('Erro no evento onAnyMessage:', error);
    }
  });
}

async function transcribeAudio(message: wppconnect.Message): Promise<string> {
  try {
    const mediaData = await message.downloadMediaAsBuffer();

    if (!mediaData) {
      return 'Desculpe, não foi possível processar o áudio.';
    }

    const filePath = `${__dirname}/temp/${message.id}.ogg`;
    fs.writeFileSync(filePath, mediaData);

    const response = await clientAssemblyAI.transcripts.create({
      audio_url: `file://${filePath}`,
    });

    fs.unlinkSync(filePath);

    return response.text;
  } catch (error) {
    console.error('Erro ao transcrever áudio:', error);
    return 'Não consigo te enviar audio';
  }
}

function splitMessages(message: string): string[] {
  message = message.trim();
  const messages = message.split(/\n\s*/);
  return messages.filter((message) => message.trim() !== '');
}