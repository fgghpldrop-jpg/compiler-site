# Compiler Site

Однофайловый C#-компилятор в интерфейсе VS Code + скрытая база знаний.

## Структура

```
Compiler_Site/
  index.html      — интерфейс
  styles.css      — стили
  app.js          — логика редактора
  server.py       — сервер + компиляция
  docs.json       — билеты (база знаний)
  project/
    Program.cs    — ваш C#-код
    Compiler.csproj
```

## Запуск

**Нужно:** Python 3 и [.NET SDK 8+](https://dotnet.microsoft.com/download)

```powershell
cd "C:\Users\ggff-\OneDrive\Desktop\Compiler_Site"
python server.py
```

Откройте в браузере: **http://localhost:8765**

Окно терминала не закрывайте — это сервер.

## Использование

| Действие | Как |
|----------|-----|
| Написать код | Редактор `Program.cs` |
| Сохранить | `Ctrl+S` или кнопка **Save** |
| Скомпилировать и запустить | Кнопка **Run** |
| База знаний | `Ctrl + Backspace` |
| Закрыть базу знаний | `Esc` |

## Пример кода

```csharp
using System;

Console.WriteLine("Hello, World!");
```

## Билеты (docs.json)

Формат:

```json
{
  "id": "01",
  "title": "Название темы",
  "content": "## Ответ\n\n**Тезис** — пояснение."
}
```

Подробнее — в разделе ниже.

---

## Создание билетов

1. Откройте `docs.json`
2. Добавьте объект в массив
3. Сохраните и обновите страницу (`F5`)

Поля: `id`, `title`, `content` (Markdown в строке, переносы через `\n`).
