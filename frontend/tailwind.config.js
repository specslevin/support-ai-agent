/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ── UI Kit semantic palette ──────────────────────────────
        // Primary / accent
        accent: '#99D52A',          // Primary — акцент, активные элементы
        'accent-hover': '#536716',  // Primary/Hover

        // Backgrounds
        base: '#0A0A0A',            // Background/Dark — фон страниц (legacy alias)
        darker: '#171717',          // Background/Darker
        frame: '#1E1E1E',           // Background/Frame — инпуты, скелетоны
        surface: '#1E1E1E',         // legacy alias → frame (инпуты/поверхности)
        card: '#252D25',            // Background/Card — карточки, модали
        'card-hover': '#1C231C',    // Background/Card/Hover — ховер строк

        // Text
        'text-primary': '#FFFFFF',
        secondary: '#ACC3A7',       // Text/Secondary — вторичный текст
        muted: '#7A8A7A',           // Text/Description — плейсхолдеры/описания (legacy alias)

        // Borders / strokes
        border: '#404040',          // Stroke/Default
        line: '#262626',            // Stroke/Subtle — 1px-разделители секций в карточке v4

        // Accent states
        orange: '#FB923C',          // Accent/Orange — ошибки
        info: '#60A5FA',            // Accent/Blue — инфо (осветлён с #146EF5: 3.6:1 → 6.4:1 на frame)
        warning: '#F3BA2F',         // Accent/Yellow — предупреждения
        success: '#22C55E',         // Green/500 — успех (осветлён с #059345: 3.6:1 → 6.3:1 на card)

        // Статусы Okdesk — значения приходят из status.color в API.
        // Единый источник для кода: src/lib/status.ts (там же контрастный текст).
        // В Figma те же значения лежат переменными status/opened … status/closed.
        status: {
          opened: '#3EDAD8',
          wait: '#2B6684',
          delayed: '#BB7DB2',
          'no-time': '#F68741',
          completed: '#67A030',
          'inst-fin': '#67A030',
          closed: '#787880',
        },

        // Green palette
        'green-bright': '#96FF1F',  // link hover
        'green-medium': '#80EE64',  // visited / icon stroke
        'green-dark': '#3F513F',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        nav: ['"Instrument Sans"', 'Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        sm: '0 1px 2px rgba(0,0,0,0.05)',
        md: '0 4px 6px -1px rgba(0,0,0,0.10)',
        lg: '0 10px 15px -3px rgba(0,0,0,0.10)',
      },
      borderRadius: {
        pill: '999px',
      },
    },
  },
  plugins: [],
}
