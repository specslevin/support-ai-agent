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

        // Accent states
        orange: '#FB923C',          // Accent/Orange — ошибки
        info: '#146EF5',            // Accent/Blue — инфо
        warning: '#F3BA2F',         // Accent/Yellow — предупреждения
        success: '#059345',         // Green/Deep — успех

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
