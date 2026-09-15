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

  // ----- Ronda 2 de equivalencias, confirmadas por Andrea via auditoria
  // (job=cursos-audit) del 14/set/2026 - typos, formato viejo, y variantes
  // "(diplomatura)" que ella pidio unificar al curso base -----

  // Typos / formato (Grupo A del audit)
  'MKTCommunity Manager': 'Community Manager',
  'Publicidad en redes avanzadas': 'Paid media: Meta & Google Ads',
  'Programacion Backend I': 'Programación Backend I: Desarrollo Avanzado de Backend',
  'Programacion Backend II': 'Programación Backend II: Diseño y Arquitectura Backend',
  'Programacion Backend III': 'Programación Backend (III): Testing y Escalabilidad',
  'Data Science I': 'Data Science I: Fundamentos para la Ciencia de Datos',
  'Diseño UXUI': 'Diseño UX/UI',
  'Customer Experience': 'Customer experience (Cx)',
  'Diseño UXUI Avanzado': 'Diseño UX/UI Avanzado',
  'Data Science II': 'Data Science II: Machine Learning para la Ciencia de Datos',
  'SEO para IA': 'SEO para AI',
  'Data Science III': 'Data Science III: NLP & Deep Learning aplicado a Ciencia de Datos',
  'Scrum- Metologias agiles': 'Scrum - Metodologías Ágiles',
  'Photoshop e ilustrator': 'Photoshop e Illustrator',
  'Bussines Analytics': 'Análisis de Datos para Negocios',
  'Prototipado (Figma y Adobe)': 'Prototipado con Figma',
  'prototipado (figma)': 'Prototipado con Figma',
  'DevOps': 'DevOps & Cloud',
  'Testing QA Manual': 'Testing QA',
  'Cloud Computing': 'Cloud Computing (AWS)',
  'creación de productos desde cero con ia': 'Vibe Coding: creá tu app con IA',
  'contenido para rrss': 'Contenido para redes sociales',
  'finanzas en inversiones desde cero': 'Finanzas e Inversiones desde cero',
  'ai agents': 'Curso de AI Agents',

  // Textos que estaban truncados a 31 caracteres en la base (origen del
  // corte todavia sin confirmar - ver nota mas abajo) - Andrea confirmo el
  // texto completo y a que curso corresponde cada uno (Grupo B del audit).
  'Introduccion a la inteligencia': 'Introducción a la Inteligencia Artificial',
  'Fundamento de inteligencia arti': 'Introducción a la Inteligencia Artificial',
  'Fundamentos de inteligencia artificial': 'Introducción a la Inteligencia Artificial',
  'Fundamentos del Marketing Digit': 'Fundamentos del Marketing Digital',
  'Creacion de productos desde 0 c': 'Vibe Coding: creá tu app con IA',
  'Inteligencia artificial aplicad': 'Creación de contenido con AI',
  'Inteligencia artificial aplicado al mkt digital': 'Creación de contenido con AI',
  'IA aplicada al MKT (Diplomaturas)': 'Creación de contenido con AI',
  // NOTA: "Inteligencia artificial Generac..." (truncado) / "inteligencia
  // artificial generación de prompt" / "Inteligencia artificial: Generación
  // de Prompts" quedan A PROPOSITO sin alias (Andrea pidio dejarlos afuera
  // de esta unificacion, 14/set/2026) - no tocar.

  // Variantes "(diplomatura)" -> unificadas al curso base (Andrea: "sacalo
  // y unificalo al curso", 14/set/2026). Las que ella marco como ambiguas
  // (Publicidad en Redes, Cultura Digital, Soft Skills, Identidad
  // Profesional y Metodologías Ágiles, Mindset Digital y Metodologías
  // Ágiles, Mentalidad de Crecimiento...) quedan A PROPOSITO sin alias -
  // pidio dejarlas afuera.
  'Metodologias agiles (diplomatura)': 'Scrum - Metodologías Ágiles',
  'React (diplomatura)': 'React JS',
  'Introducción a la Inteligencia Artificial (Diplomaturas)': 'Introducción a la Inteligencia Artificial',
  'Diseño UX/UI (Diplomatura)': 'Diseño UX/UI',
  'Photoshop e Illustrator (Diplomatura)': 'Photoshop e Illustrator',
  'Prototipado (diplomatura)': 'Prototipado con Figma',
  'Data science 1 (diplomatura)': 'Data Science I: Fundamentos para la Ciencia de Datos',
  'SEO para AI (diplomatura)': 'SEO para AI',
  'Customer experience (CX) (Diplomatura)': 'Customer experience (Cx)',
  'JavaScript (diplomatura)': 'Javascript',
  'Data Analytics (Diplomatura)': 'Data Analytics',
  'Programacion Backend III (diplomatura)': 'Programación Backend (III): Testing y Escalabilidad',
  'Community Manager & Publicidad (Diplomatura)': 'Community Manager',
  'Power Bi (Diplomatura)': 'Power BI',
  'BE II: Diseño y arquitectura Backend (diplomatura)': 'Programación Backend II: Diseño y Arquitectura Backend',
};

// Textos que Andrea pidio ELIMINAR directamente de "cursos habilitados a
// dictar" (no se unifican a ningun curso, se sacan) porque son cursos que
// "no existen mas" (14/set/2026, revision del audit). Solo aplica a
// cursosHabilitados - no se tocan certificaciones/preguntas/excepciones con
// este texto porque el audit no encontro ninguno de estos ahi.
const DESCARTAR_CURSO = [
  'UI',
  'Nuevo onboarding para Tutores',
  'Curso de Arquitectura de Datos Moderna',
  'Inbound Marketing',
  'Workshop de IA',
  'IA Aplicada para 4to Año (Nivel 2)',
  'gestión de ai agents para líderes y pms',
  'Mentoría digital estratégica para supervisores de Claro',
];

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
const DESCARTAR_NORM = new Set(DESCARTAR_CURSO.map(normLoose));

// true si este texto de curso es uno de los que Andrea pidio eliminar
// directamente (ver DESCARTAR_CURSO mas arriba) - se compara con la misma
// normalizacion estricta que el resto de este archivo, nunca por similitud.
function esDescartable(raw) {
  return DESCARTAR_NORM.has(normLoose(raw));
}

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
  CURSOS_CANONICOS, ALIAS_CURSO, DESCARTAR_CURSO, normLoose, resolveCurso, esDescartable,
};
