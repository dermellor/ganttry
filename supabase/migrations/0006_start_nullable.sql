-- Items dürfen jetzt ohne Start existieren: ein über die Listenansicht neu
-- angelegter Eintrag startet mit leerem Start/Ende/Dauer und wird erst beim
-- Ausfüllen konkret. Der Timeline-Viewer blendet startlose Items clientseitig
-- aus (vis-timeline braucht einen Start zum Platzieren); die Liste zeigt sie mit
-- „—". `end` und `duration` waren bereits nullable.
alter table public.timeline_items
  alter column start drop not null;
