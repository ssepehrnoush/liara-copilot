// Book catalogue for the demo shop (generated, fictional titles).
const TITLES = [
  'باغ شبانه', 'راه ابریشم', 'کوچهٔ اقاقیا', 'سفر به دماوند', 'نامه‌های تهران', 'دریای خزر', 'خانهٔ پدری', 'آسمان کویر',
  'شهر کتاب‌ها', 'زمستان سبز', 'قصه‌های مادربزرگ', 'نقشهٔ گنج', 'چراغ‌های شیراز', 'رودخانهٔ آرام', 'کافهٔ نادری', 'برنامه‌نویسی شاد',
  'هنر ساده نوشتن', 'تاریخ چای', 'پرنده‌های البرز', 'یک فنجان شعر',
];
const AUTHORS = ['م. روشن', 'س. امیری', 'ن. کاوه', 'ر. صدری', 'ف. نیک‌نام', 'ل. آذر'];

export const products = Array.from({ length: 200 }, (_, i) => ({
  id: i + 1,
  title: `${TITLES[i % TITLES.length]}${i >= TITLES.length ? ` (جلد ${Math.floor(i / TITLES.length) + 1})` : ''}`,
  author: AUTHORS[i % AUTHORS.length],
  price: 85000 + ((i * 7919) % 30) * 5000,
  stock: (i * 31) % 17,
  description: 'کتابی خواندنی برای روزهای آرام؛ چاپ تازه با جلد سخت و کاغذ مرغوب. '.repeat(6),
}));
