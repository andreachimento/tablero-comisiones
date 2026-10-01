// ============================================================================
// Que producto del back office le corresponde a cada curso del tablero
// ============================================================================
// Cuando se aprueba una certificacion de PROFESOR, el tablero le agrega el
// curso a "ver certificaciones" del perfil de esa persona en el back office
// (ver lib/certificacionesBO.js). El back office no trabaja con nombres de
// curso sino con el ID del producto, asi que hace falta esta tabla.
//
// COMO SE ARMO (set./oct. 2026): se cruzaron los 61 nombres de la lista
// oficial del tablero (lib/cursosCanonicos.js) contra los 167 cursos ACTIVOS
// del catalogo del back office. Donde un mismo nombre aparecia dos veces con
// IDs distintos, se eligio el que concentra las comisiones reales y se
// descarto el duplicado sin uso (ej. Growth Marketing: 136 comisiones contra
// 1). Andrea reviso y confirmo la tabla entera, una fila por vez.
//
// NO SE ADIVINA NADA: si un curso no esta en esta lista, o esta con null, la
// certificacion se aprueba igual en el tablero y simplemente no se empuja al
// back office. Es a proposito: preferimos que falte un dato alla y se note,
// antes que escribir el producto equivocado en el perfil de alguien.
//
// Los tres con null todavia no tienen producto creado en el back office
// (confirmado por Andrea, oct. 2026). Cuando se creen, se completa el ID aca
// y empiezan a empujarse solos, sin tocar nada mas.
//
// OJO: el nombre que se guarda en una certificacion es texto libre con
// historia (variantes viejas, la palabra "Flex", etc.), por eso la busqueda
// pasa SIEMPRE por resolveCurso() de lib/cursosCanonicos.js, que lo lleva al
// nombre oficial antes de buscar aca.
// ============================================================================

const { resolveCurso } = require('./cursosCanonicos');

// curso oficial -> id del producto en el back office (null = todavia no existe)
const PRODUCTO_POR_CURSO = {
  'Canva':                                                             'c8c43479-2666-4116-910e-95482da8bc39',
  'Fundamentos del Diseño Gráfico':                                    'be9e651d-6f22-480e-b32c-15b5874b7446',
  'Photoshop e Illustrator':                                           '89fade6f-a2b8-4f1e-9ab9-5f7cce9094c5',
  'Análisis de Datos para Negocios':                                   '1fca8609-f05c-44ab-bb31-c3abf7f1fb27',  // Business Analytics
  'Ciberseguridad':                                                    '7079bb35-f8e4-496f-bd32-070c3a22d3a3',
  'Data Analytics':                                                    '804123bd-e8d3-483e-87f3-46af58833a15',
  'Data Science I: Fundamentos para la Ciencia de Datos':              '812ff8df-77e6-41c0-adb3-7704826c0757',
  'Data Science II: Machine Learning para la Ciencia de Datos':        '29957ec9-c5fe-4620-8ad0-03d41bff01c7',
  'Data Science III: NLP & Deep Learning aplicado a Ciencia de Datos': '16f8402e-c44a-4967-8a96-fd91b692e0ef',
  'Data Engineering':                                                  'd054d70b-810b-4fbb-9f1b-3795b5507dbe',
  'Excel':                                                             '402b2132-ff27-4db8-8a89-53338518d099',
  'Excel avanzado':                                                    'b77b5e21-6d62-4a4b-9124-7a8eb0d8ff03',  // Excel Avanzado
  'Power BI':                                                          '011d1bcd-1d33-4d79-bce2-7f079e558930',
  'Tableau':                                                           '2285910c-8430-4f15-bf44-84960d834d9f',
  'Diseño UX/UI':                                                      'b9fa5436-abca-431e-b971-176b57357cc1',
  'Diseño UX/UI Avanzado':                                             '262ecc6e-3158-49bc-9d77-5c344208ab42',
  'Prototipado con Figma':                                             '39c9c464-424d-4c44-a781-a2c44050f8a5',
  'UX Research':                                                       'dfce5a26-c39e-474f-9c15-0d7d71409777',
  'UX Writing':                                                        'caa08e5f-939b-4245-8103-65b3277c8b70',
  'Community Manager':                                                 'ff37e7ed-9b04-4ff5-971b-d0a6630e6c3b',
  'Fundamentos del Marketing Digital':                                 '8ade7dd7-a114-4fdd-9ea7-cb7e3754e237',  // Fundamentos del Marketing digital
  'Google Ads, Analytics & Looker Studio':                             'cdcd69ca-5537-4513-9823-5791abc2fdb7',
  'Contenido para redes sociales':                                     'd77a8618-3078-47df-9e1a-d91bd1adb097',
  'Copywriting':                                                       '29ba505b-0dbd-412f-a681-f11a0a8f8f3e',
  'Fotografía para RRSS':                                              '667fc217-3beb-4c04-b00a-94c6f17d5078',
  'Growth Marketing':                                                  '3a5ed77d-01aa-4d61-858f-cbad985c780c',
  'Paid media: Meta & Google Ads':                                     'c911701d-746c-45cf-898f-28e74f3317dc',
  'SEO para AI':                                                       '4be0981d-3fd3-4489-a782-003f512d0a5d',  // SEO Para AI
  'Customer experience (Cx)':                                          '4d90b733-d6ee-44d4-9427-89f6ac17ccb9',  // Customer Experience (CX)
  'E-Commerce':                                                        '3837af1a-6753-48e4-aca5-36ac1cfd77ff',  // E-commerce
  'Product Manager':                                                   'a71f2d82-e37e-4847-b616-397b68c04ccb',
  'Scrum - Metodologías Ágiles':                                       '9b8aa285-b5fc-491a-8c62-039847239b23',
  'Cloud Computing (AWS)':                                             '2a8270a7-ae65-4bda-9608-a92cdf9a383c',
  'Desarrollo de aplicaciones':                                        '4f13037d-8563-4573-80c8-a46484152606',  // Desarrollo de Aplicaciones
  'Desarrollo Web':                                                    '29b893bc-270b-4077-86a9-870cc6dc6e25',
  'Javascript':                                                        '1b2dff06-72d9-458b-b83e-e160d51fe380',  // JavaScript
  'Programación Backend I: Desarrollo Avanzado de Backend':            '1645d0d0-9944-4b3d-83bd-fc902f95470d',
  'Programación Backend II: Diseño y Arquitectura Backend':            'fd2b00b2-d897-4bfc-8343-e9e98da1f6fc',
  'Programación Backend (III): Testing y Escalabilidad':               '1baf8cdd-0b2a-4226-acdc-6df89cc1c6b3',
  'Python':                                                            'db51789c-d720-4c7a-ba8e-58fe8478877a',
  'React JS':                                                          '3faa2efc-759a-4694-b810-c4c9a3bbd583',
  'SQL':                                                               'fb940409-6b79-4716-b0ed-94623f6e3965',
  'Testing QA':                                                        '42e5764e-9aca-4fb3-a612-b49dca895ae5',  // Testing QA Manual
  'Wordpress':                                                         '6bc9dc94-761d-43b9-a031-46737c952751',
  'Administración de Empresas':                                        'f5c1984d-c730-4f8e-9e90-4215bffba408',  // Administración de empresas
  'Contabilidad':                                                      'f361542a-fb83-4245-91e0-64b616601d8b',
  'Finanzas e Inversiones desde cero':                                 'c308933b-c365-45a4-819b-5b642fea09b0',  // Finanzas e inversiones desde cero
  'Técnicas de Negociación':                                           'af22653d-bb39-4538-86c1-7502b2142f22',
  'Liderazgo y gestión de equipos':                                    '098b0cba-4e2b-439a-8b98-46df31529a8c',
  'Oratoria':                                                          '30d416c2-51ab-4683-b14e-0e7ceb267554',
  'Introducción a la Inteligencia Artificial':                         '7f50aac2-67a7-43f2-b91a-ee90fb8485c2',
  'AI Automation':                                                     '413a121c-0781-4c10-96a3-5ace5f9fbba7',
  'AI Automation Avanzado':                                            'cae855ea-b408-4646-ae42-01b21e1ad095',
  'Vibe Coding: creá tu app con IA':                                   '716933d6-ac00-42a3-a3db-60932f1ae08d',
  'Creación de contenido con AI':                                      '6ddf312c-00da-47ad-b81e-cfc735deeb04',
  'Curso de AI Agents':                                                '77aee8bd-03cd-4048-be77-340976b8e6d4',  // Curso de AI Agents 
  'DevOps & Cloud':                                                    '68fe2656-c75e-4e50-bb69-733892c346e3',
  'AI Engineering':                                                    'd3939cad-a008-4771-a4e6-2efe6ebbbe31',
  'AI para el trabajo y Ventas & Negociación':                         null,  // todavia sin producto en el back office
  'Ai builders program':                                               null,  // todavia sin producto en el back office
  'Forward Deployed Engineer':                                         null,  // todavia sin producto en el back office
};

// Devuelve el ID del producto del back office para un nombre de curso
// cualquiera (ya normalizado o no), o null si no se puede resolver con
// certeza. Null significa "no empujar nada", nunca "probar con otro".
function productoDeCurso(curso) {
  if (!curso) return null;
  // resolveCurso devuelve { original, canonico, origen }: canonico es null
  // cuando el texto no coincide con ningun nombre oficial ni con un alias ya
  // confirmado. En ese caso no se empuja nada.
  const { canonico } = resolveCurso(curso);
  if (!canonico) return null;
  return PRODUCTO_POR_CURSO[canonico] || null;
}

module.exports = { PRODUCTO_POR_CURSO, productoDeCurso };
