-- Russian is the default interface language. Languages that were only guessed from the Telegram
-- app become Russian; anyone who chose a language themselves (/language, Mini App) keeps it.
UPDATE members SET lang='ru' WHERE lang_explicit=0;
