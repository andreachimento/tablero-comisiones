// ============================================================================
// Lista UNICA y oficial de los cursos que dicta Coderhouse (60, set. 2026,
// confirmada por Andrea) + equivalencias con nombres viejos que hay que
// "traducir" al nombre nuevo. Se usa para LIMPIAR los nombres de curso que
// ya estan guardados en la base propia del tablero (cursosHabilitados de
// cada perfil, certificaciones, banco de preguntas, excepciones) - todos
// esos son texto libre que fue quedando con variantes, nombres viejos y la
// palabra "Flex" (que ya no se usa).
//
// IMPORTANTE: esto NO reemplaza a normalizeCurso()/cursoMatches() de
// lib/elegibilidad.js, que sirven para OTRA cosa (comparar un nombre de
// curso propio contra el nombre completo que devuelve el back office de
// Coderhouse en vivo, de forma flexible/aproximada). Aca el objetivo es
// distinto y mas estricto: decidir a que uno de los 60 nombres oficiales
// corresponde un texto ya guardado, SIN adivinar - si no hay un match exacto
// o una equivalencia ya confirmada por Andrea, el curso queda "sin mapear" y
// hay que preguntarle a ella, nunca se asigna solo.
// ============================================================================

// Los 60 nombres oficiales, ya sin la palabra "Flex".
const CURSOS_CANONICOS = [
  'Canva',
  'Fundamentos del Diseño Gráfico',
  'Photoshop e Illustrator',
  'Análisis de Datos para Negocios',
  'Ciberseguridad',
  'Data Analytics',
  'Data Science I: Fundamentos para la Ciencia de Datos',
  'Data Science II: Machine Learning para la Ciencia de Datos',
  'Data Science III: NLP & Deep Learning aplicado a Ciencia de Datos',
  'Data Engineering',
  'Excel',
  'Excel avanzado',
  'Power BI',
  'Tableau',
  'Diseño UX/UI',
  'Diseño UX/UI Avanzado',
  'Prototipado con Figma',
  'UX Research',
  'UX Writing',
  'Community Manager',
  'Fundamentos del Marketing Digital',
  'Google Ads, Analytics & Looker Studio',
  'Contenido para redes sociales',
  'Copywriting',
  'Fotografía para RRSS',
  'Growth Marketing',
  'Paid media: Meta & Google Ads',
  'SEO para AI',
  'Customer experience (Cx)',
  'E-Commerce',
  'Product Manager',
  'Scrum - Metodologías Ágiles',
  'Cloud Computing (AWS)',
  'Desarrollo de aplicaciones',
  'Desarrollo Web',
  'Javascript',
  'Programación Backend I: Desarrollo Avanzado de Backend',
  'Programación Backend II: Diseño y Arquitectura Backend',
  'Programación Backend (III): Testing y Escalabilidad',
  'Python',
  'React JS',
  'SQL',
  'Testing QA',
  'Wordpress',
  'Administración de Empresas',
  'Contabilidad',
  'Finanzas e Inversiones desde cero',
  'Técnicas de Negociación',
  'Liderazgo y gestión de equipos',
  'Oratoria',
  'Introducción a la Inteligencia Artificial',
  'AI Automation',
  'AI Automation Avanzado',
  'Vibe Coding: creá tu app con IA',
  'Creación de contenido con AI',
  'Curso de AI Agents',
  'DevOps & Cloud',
  'AI Engineering',
  'AI para el trabajo y Ventas & Negociación',
  'Ai builders program',
];

// Nombres viejos -> nombre nuevo oficial, confirmados por Andrea (14/set/2026).
// Cada vez que ella marque una equivalencia nueva, se agrega aca (una linea
// mas), nunca se adivina una por similitud sola.
const ALIAS_CURSO = {
  'Business Analytics': 'Análisis de Datos para Negocios',
  'Marketing Digital: Community Manager & Publicidad Flex': 'Community Manager',
  'Marketing Digital: Community Manager & Publicidad': 'Community Manager',
  'Google Ads': 'Google Ads, Analytics & Looker Studio',
  'Publicidad en Redes Avanzado Flex': 'Paid media: Meta & Google Ads',
  'Publicidad en Redes Avanzado': 'Paid media: Meta & Google Ads',
  'Finanzas personales': 'Finanzas e Inversiones desde cero',
  'Creación de productos desde 0 con AI': 'Vibe Coding: creá tu app con IA',
  'MKT DIGITAL': 'Creación de contenido con AI',
};

function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Normalizacion ESTRICTA para esta limpieza puntual: saca acentos, mayusculas,
// la palabra "Flex" y diferencias de espacios/puntuacion - pero a proposito
// NO trunca en los dos puntos ni hace match por prefijo (a diferencia de
// normalizeCurso() en elegibilidad.js), porque aca varios nombres oficiales
// son prefijo unos de otros a proposito (ej. "Excel" y "Excel avanzado",
// "Diseño UX/UI" y "Diseño UX/UI Avanzado") y confundirlos seria un error.
function normLoose(s) {
  return stripAccents(String(s || ''))
    .toLowerCase()
    .replace(/\bflex\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const CANON_BY_NORM = new Map(CURSOS_CANONICOS.map(c => [normLoose(c), c]));
const ALIAS_BY_NORM = new Map(Object.entries(ALIAS_CURSO).map(([k, v]) => [normLoose(k), v]));

// Devuelve { canonico, origen } donde origen es:
//   'ya_canonico' -> el texto ya era (o solo le faltaba sacar "Flex"/tildes/
//                    espacios de mas) uno de los 60 nombres oficiales.
//   'alias'       -> matcheo una equivalencia ya confirmada por Andrea.
//   null          -> no hay match seguro; canonico queda null y hay que
//                    preguntarle a Andrea (NUNCA se adivina por similitud).
function resolveCurso(raw) {
  const texto = String(raw || '').trim();
  if (!texto) return { original: texto, canonico: null, origen: null };
  const norm = normLoose(texto);
  if (CANON_BY_NORM.has(norm)) {
    return { original: texto, canonico: CANON_BY_NORM.get(norm), origen: 'ya_canonico' };
  }
  if (ALIAS_BY_NORM.has(norm)) {
    return { original: texto, canonico: ALIAS_BY_NORM.get(norm), origen: 'alias' };
  }
  return { original: texto, canonico: null, origen: null };
}

module.exports = {
  CURSOS_CANONICOS, ALIAS_CURSO, normLoose, resolveCurso,
};
