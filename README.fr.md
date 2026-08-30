# Pi Harbor (Français)

[English](README.md) · [Chinois simplifié](README.zh-Hans.md) · [Chinois traditionnel](README.zh-Hant.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · Français · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Pi Harbor est un client Web open source, pensé d'abord pour le mobile, destiné à Pi coding agent. Il permet de consulter et poursuivre des sessions, créer des projets, prévisualiser des images et changer d'ordinateur Pi Harbor.

## Confidentialité

Le dépôt contient uniquement le code de l'application et des modèles de déploiement génériques. Il ne contient aucun token, journal de session, fichier de projet, URL privée, identifiant, historique d'utilisation de modèles, statistiques d'usage ni configuration propre à une machine. Conservez le token dans un fichier local en mode `600` et utilisez une passerelle HTTPS.

## Démarrage rapide

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/pi-harbor/master/install.sh)"
```

Sur l’ordinateur qui exécute Pi Harbor, ouvrez le Terminal et exécutez :

```bash
cat ~/.config/pi-harbor/token
```

Collez le jeton dans l’écran de connexion. Depuis un autre appareil, récupérez-le en toute sécurité sur cet hôte. Si `PI_HARBOR_TOKEN_FILE` est explicitement configuré, lisez le fichier configuré plutôt que le chemin par défaut. Ne placez jamais le jeton dans Git, un chat, une capture ou un journal.

Lorsque Pi Harbor est ouvert pour la première fois dans un navigateur sur l’ordinateur hôte lui-même, une révélation unique de la clé privée, façon portefeuille matériel, est proposée avant la connexion. Elle n’est affichée que sur les connexions loopback — jamais via Tailscale Serve, un proxy ou un appareil distant — et disparaît définitivement après les deux confirmations. Les autres appareils utilisent toujours la clé enregistrée ou le fichier de jeton.

Installez et lancez Pi Harbor sur chaque ordinateur, puis ajoutez une adresse Tailscale ou HTTPS dans **Settings → Devices → Add device**. La saisie manuelle d’une URL conserve l’ancien parcours avec jeton Web partagé et exige le même jeton sur les deux hôtes. Un code `PIHARBOR3`, valable cinq minutes et utilisable une seule fois, crée après vérification de la cible un identifiant de pair indépendant et révocable, sans envoyer le jeton partagé à l’URL candidate. Les appareils autorisés peuvent être listés et révoqués dans les réglages, avec effet immédiat. Pi Harbor 2.2 accepte les codes `PIHARBOR2` d’un hôte 2.1.2 ; les anciens clients doivent être mis à jour avant `PIHARBOR3`. N’exposez pas le port 3140. Dans **Settings → Connection → Models & providers**, choisissez un service du catalogue, un compte/OAuth, une clé API, un service local ou un fournisseur personnalisé, puis sélectionnez les modèles visibles. Les modèles launchd de `deploy/` permettent les mises à jour automatiques.

```bash
npm run check
npm test
```

Consultez la [documentation anglaise](README.md) pour les détails.
