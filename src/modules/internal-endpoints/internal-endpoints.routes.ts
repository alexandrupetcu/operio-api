import type { FastifyInstance } from "fastify";

export interface InternalEndpoint {
  method: string;
  path: string;
  description: string;
  category: string;
  /** Representative response shape, surfaced in the event-listener editor so
   *  authors can build response mappings against the real fields. */
  responseSample?: unknown;
}

const INTERNAL_ENDPOINTS: InternalEndpoint[] = [
  // Clients
  { method: "GET", path: "/api/clients", description: "Listează clienții", category: "Clienți" },
  { method: "POST", path: "/api/clients", description: "Creează client nou", category: "Clienți" },
  { method: "GET", path: "/api/clients/:id", description: "Obține client după ID", category: "Clienți" },
  { method: "PATCH", path: "/api/clients/:id", description: "Actualizează client", category: "Clienți" },
  { method: "DELETE", path: "/api/clients/:id", description: "Șterge client", category: "Clienți" },

  // Projects
  { method: "GET", path: "/api/projects", description: "Listează proiectele", category: "Proiecte" },
  { method: "POST", path: "/api/projects", description: "Creează proiect nou", category: "Proiecte" },
  { method: "GET", path: "/api/projects/:id", description: "Obține proiect după ID", category: "Proiecte" },
  { method: "PATCH", path: "/api/projects/:id", description: "Actualizează proiect", category: "Proiecte" },
  { method: "GET", path: "/api/projects/calendar", description: "Proiecte în format calendar", category: "Proiecte" },

  // Project Types
  { method: "GET", path: "/api/project-types", description: "Listează tipurile de proiecte", category: "Tipuri Proiecte" },
  { method: "POST", path: "/api/project-types", description: "Creează tip de proiect", category: "Tipuri Proiecte" },
  { method: "PATCH", path: "/api/project-types/:id", description: "Actualizează tip de proiect", category: "Tipuri Proiecte" },
  { method: "DELETE", path: "/api/project-types/:id", description: "Șterge tip de proiect", category: "Tipuri Proiecte" },

  // Tasks
  { method: "GET", path: "/api/tasks", description: "Listează task-urile", category: "Task-uri" },
  { method: "POST", path: "/api/tasks", description: "Creează task nou", category: "Task-uri" },
  { method: "GET", path: "/api/tasks/:id", description: "Obține task după ID", category: "Task-uri" },
  { method: "PATCH", path: "/api/tasks/:id", description: "Actualizează task", category: "Task-uri" },
  { method: "POST", path: "/api/tasks/:id/complete", description: "Marchează task ca finalizat", category: "Task-uri" },

  // Workflow Instances
  { method: "POST", path: "/api/workflow-instances/project/:projectId/start", description: "Pornește workflow pentru proiect", category: "Workflow Runtime" },
  { method: "GET", path: "/api/workflow-instances/project/:projectId", description: "Obține instanța workflow după proiect", category: "Workflow Runtime" },
  { method: "GET", path: "/api/workflow-instances/:id", description: "Obține instanța workflow după ID", category: "Workflow Runtime" },
  { method: "GET", path: "/api/workflow-instances/:id/logs", description: "Obține logurile de execuție", category: "Workflow Runtime" },
  { method: "POST", path: "/api/workflow-instances/step-instances/:stepInstanceId/complete", description: "Finalizează un pas din workflow", category: "Workflow Runtime" },
  { method: "POST", path: "/api/workflow-instances/step-instances/:stepInstanceId/fail", description: "Marchează pas ca eșuat", category: "Workflow Runtime" },
  { method: "POST", path: "/api/workflow-instances/:id/cancel", description: "Anulează workflow", category: "Workflow Runtime" },

  // Workflow Definitions
  { method: "GET", path: "/api/workflow-definitions", description: "Listează definițiile de workflow", category: "Workflow Definiții" },
  { method: "GET", path: "/api/workflow-definitions/:id", description: "Obține definiție workflow după ID", category: "Workflow Definiții" },
  { method: "POST", path: "/api/workflow-definitions/:id/publish", description: "Publică definiție workflow", category: "Workflow Definiții" },
  { method: "POST", path: "/api/workflow-definitions/:id/clone", description: "Clonează definiție workflow", category: "Workflow Definiții" },

  // Documents
  { method: "GET", path: "/api/documents", description: "Listează documentele", category: "Documente" },
  {
    method: "POST",
    path: "/api/documents/parse-permits",
    description: "Parsează avize și documente necesare din document (GPT-4.1)",
    category: "Documente",
    responseSample: {
      avize: [
        {
          nume: "Aviz alimentare cu apă și canalizare",
          emitent: "Compania de Apă",
          categorie: "avize_utilitati",
          observatii: "",
          alternativa: "",
          incert: false,
        },
        {
          nume: "Aviz gaze naturale",
          emitent: "Distrigaz Sud Rețele",
          categorie: "avize_utilitati",
          incert: false,
        },
      ],
      documente: [
        { nume: "Certificat de urbanism", categorie: "documente_de_baza", descriere: "", incert: false },
      ],
      checklist: [{ titlu: "Avize utilități", items: ["Apă-canal", "Gaze naturale", "Electrica"] }],
      rezumat: "Rezumat scurt al avizelor și documentelor necesare.",
    },
  },
  {
    method: "POST",
    path: "/api/documents/project/:projectId/parse-authorization",
    description: "Parsează autorizația de construire (nr/dată/emitent) și o salvează pe proiect (GPT-4.1)",
    category: "Documente",
    responseSample: {
      autorizatie_construire_nr: "329",
      autorizatie_construire_data: "15.09.2025",
      autorizatie_construire_emitent: "Primăria Măgurele",
    },
  },
  { method: "POST", path: "/api/documents/generate", description: "Generează document din template", category: "Documente" },
  { method: "GET", path: "/api/documents/:id", description: "Obține document după ID", category: "Documente" },
  { method: "DELETE", path: "/api/documents/:id", description: "Șterge document", category: "Documente" },

  // Notifications
  { method: "GET", path: "/api/notifications", description: "Listează notificările", category: "Notificări" },
  { method: "POST", path: "/api/notifications", description: "Trimite notificare", category: "Notificări" },
  { method: "PATCH", path: "/api/notifications/:id/read", description: "Marchează notificare ca citită", category: "Notificări" },

  // Users
  { method: "GET", path: "/api/users", description: "Listează utilizatorii", category: "Utilizatori" },
  { method: "GET", path: "/api/users/:id", description: "Obține utilizator după ID", category: "Utilizatori" },
  { method: "PATCH", path: "/api/users/:id", description: "Actualizează utilizator", category: "Utilizatori" },

  // Employees
  { method: "GET", path: "/api/employees", description: "Listează angajații", category: "Angajați" },
  { method: "POST", path: "/api/employees", description: "Adaugă angajat", category: "Angajați" },
  { method: "PATCH", path: "/api/employees/:id", description: "Actualizează angajat", category: "Angajați" },
  { method: "DELETE", path: "/api/employees/:id", description: "Șterge angajat", category: "Angajați" },

  // Services
  { method: "GET", path: "/api/services", description: "Listează serviciile", category: "Servicii" },
  { method: "POST", path: "/api/services", description: "Creează serviciu nou", category: "Servicii" },
  { method: "PATCH", path: "/api/services/:id", description: "Actualizează serviciu", category: "Servicii" },
  { method: "DELETE", path: "/api/services/:id", description: "Șterge serviciu", category: "Servicii" },

  // Vehicles
  { method: "GET", path: "/api/vehicles", description: "Listează vehiculele", category: "Vehicule" },
  { method: "POST", path: "/api/vehicles", description: "Adaugă vehicul", category: "Vehicule" },
  { method: "PATCH", path: "/api/vehicles/:id", description: "Actualizează vehicul", category: "Vehicule" },
  { method: "DELETE", path: "/api/vehicles/:id", description: "Șterge vehicul", category: "Vehicule" },

  // ANAF
  { method: "GET", path: "/api/anaf/company", description: "Obține date companie după CUI (ANAF)", category: "ANAF" },

  // Tenant
  { method: "GET", path: "/api/tenant", description: "Obține informații tenant", category: "Tenant" },

  // Audit
  { method: "GET", path: "/api/audit-logs", description: "Listează logurile de audit", category: "Audit" },

  // Geography
  {
    method: "GET",
    path: "/api/geography/countries",
    description: "Listează țările",
    category: "Geografie",
    responseSample: [{ id: 181, name: "Romania", iso2: "RO", emoji: "🇷🇴" }],
  },
  { method: "GET", path: "/api/geography/states", description: "Listează județele", category: "Geografie" },
  { method: "GET", path: "/api/geography/cities", description: "Listează orașele", category: "Geografie" },

  // Scheduled Jobs
  { method: "GET", path: "/api/scheduled-jobs", description: "Listează job-urile programate", category: "Job-uri Programate" },
  { method: "POST", path: "/api/scheduled-jobs/:id/retry", description: "Reîncercă job eșuat", category: "Job-uri Programate" },
];

export default async function internalEndpointsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", fastify.authenticate);

  fastify.get("/", async () => {
    return INTERNAL_ENDPOINTS;
  });
}
