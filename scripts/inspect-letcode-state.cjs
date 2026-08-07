'use strict';
const prisma = require('../server/prisma');

(async () => {
  try {
    const projects = await prisma.project.findMany({
      where: { name: { contains: 'letcode' } },
      include: {
        requirements: true,
        scenarioGenerations: { orderBy: { createdAt: 'desc' } },
        scenarios: { include: { cases: true } },
        calibrations: { orderBy: { createdAt: 'desc' } },
      },
    });

    console.log('--- LETCODE PROJECTS IN DB ---');
    console.log(JSON.stringify(projects.map(p => ({
      id: p.id,
      name: p.name,
      targetUrl: p.targetUrl,
      requirementsCount: p.requirements.length,
      generationsCount: p.scenarioGenerations.length,
      generations: p.scenarioGenerations.map(g => ({ id: g.id, version: g.version, isCurrent: g.isCurrent, status: g.status })),
      scenariosCount: p.scenarios.length,
      casesCount: p.scenarios.reduce((acc, s) => acc + s.cases.length, 0),
      calibrationsCount: p.calibrations.length,
      latestCalibration: p.calibrations[0] ? { id: p.calibrations[0].id, pageCount: p.calibrations[0].discoveredUrlsJson } : null,
    })), null, 2));

    await prisma.$disconnect();
  } catch (err) {
    console.error('Error inspecting letcode state:', err);
  }
})();
