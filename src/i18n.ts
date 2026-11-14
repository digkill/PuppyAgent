import type { Language } from './types.ts';

const en = {
  created: 'Created', configure: 'Set the provider model in config and its API key in Puppy Agent .env before chatting.',
  noModels: 'No models returned.', noSessions: 'No saved sessions.', noSession: 'No saved session found.',
  stopping: 'Stopping puppies; saving progress…', approvalDenied: 'Approval required; denied in noninteractive mode',
  allow: 'Allow', yesNo: '[y/N]', helper: 'helper', recovered: 'Recovered interrupted tool calls; actions will not be replayed automatically.',
  welcome: 'Friendly paws, serious work. /help for commands.', you: 'you',
  unknownCommand: 'Unknown command. /help', summarized: 'Context summarized; full transcript retained.',
  noCompaction: 'No compaction needed.', memorySaved: 'Project memory saved.', memoryRemoved: 'Project memory removed.',
  tokens: 'Tokens (reported subtotal)', modelMissing: '(model not configured)',
  fullAccess: 'Full access: tools and shell commands run without confirmation under your OS account.',
  terminalRequired: 'Interactive chat needs a terminal. Use: puppy run "task"',
  languageSet: 'Language: English',
};
type Key = keyof typeof en;
const ru: Record<Key, string> = {
  created: 'Создан', configure: 'Укажи модель в настройках и API-ключ в .env самого Puppy Agent перед началом работы.',
  noModels: 'Провайдер не вернул моделей.', noSessions: 'Сохранённых сессий нет.', noSession: 'Сохранённая сессия не найдена.',
  stopping: 'Останавливаю щенков; сохраняю прогресс…', approvalDenied: 'Нужно подтверждение; в неинтерактивном режиме отклонено',
  allow: 'Разрешить', yesNo: '[y/да/N]', helper: 'щенок', recovered: 'Найдены прерванные вызовы инструментов; автоматического повтора не будет.',
  welcome: 'Дружелюбные лапы, серьёзная работа. Команды: /help.', you: 'ты',
  unknownCommand: 'Неизвестная команда. /help', summarized: 'Контекст сжат; полная история сохранена.',
  noCompaction: 'Сжатие не требуется.', memorySaved: 'Память проекта сохранена.', memoryRemoved: 'Запись памяти проекта удалена.',
  tokens: 'Токены (известная сумма)', modelMissing: '(модель не настроена)',
  fullAccess: 'Полный доступ: инструменты и shell выполняются без подтверждений с правами твоего пользователя ОС.',
  terminalRequired: 'Для чата нужен терминал. Используй: puppy run "задача"',
  languageSet: 'Язык: русский',
};
export function t(language: Language, key: Key): string { return (language === 'ru' ? ru : en)[key]; }
export function language(value: string): Language {
  if (value !== 'en' && value !== 'ru') throw new Error('Language must be en or ru. / Язык: en или ru.');
  return value;
}
export function helpText(lang: Language): string {
  const commands = `
  puppy init [--tmp /absolute/temp/path] [--language en|ru]
  puppy models [--provider name]
  puppy [chat] [--new] [--cwd path] [--provider name] [--permission mode] [--language en|ru]
               [--model MODEL_ID] [--effort LEVEL]
  puppy run "task" [--cwd path] [--permission mode] [--language en|ru]
  puppy resume [session-id | --last | --here]
  puppy sessions [--here]
  puppy usage [session-id] [--run-id TASK_ID] [--json]
  puppy config
  puppy install [--prefix PATH]
  puppy update [--check | --local] [--source PATH]
  puppy --version
  Output: --color / --no-color / --no-markdown

  /help /sessions /resume ID /new /cd PATH /status /permissions MODE
  /provider [NAME] /model [MODEL_ID] /fallback /effort [auto|low|medium|high|xhigh|max]
  /language en|ru /usage [json] /memory /remember KEY VALUE /forget KEY /compact /continue /exit
  From source checkout: npm start -- <command>
`;
  return lang === 'ru'
    ? `🐶 Puppy Agent\n${commands}\nРежимы: read-only, ask, workspace-write, full-access\nchat восстанавливает последнюю сессию директории; --new создаёт новую.\nresume --last восстанавливает последнюю сессию и её рабочую директорию.\nrun отклоняет действия, требующие подтверждения. Полный доступ выбирается явно.`
    : `🐶 Puppy Agent\n${commands}\nModes: read-only, ask, workspace-write, full-access\nchat restores the latest session for the directory; --new starts fresh.\nresume --last restores the latest session and its saved working directory.\nNoninteractive run denies requests that require approval. Full access is selected explicitly.`;
}
