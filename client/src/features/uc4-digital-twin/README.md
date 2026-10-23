# UC4 - Digital twin

Route: `#/uc4`

UC4 displays the CENTRAL warehouse's 3D rack view and saved UC3 relocation recommendations in the MedFlow app. The scene is mounted from `twin.js`, which provides orbit controls, overview/plan/floor camera

The page reads the live bin hierarchy through UC3's current-layout adapter without scanning inventory history, and reads only the latest persisted UC3 recommendation run through its recommendation adapter.

The 3D model maps structured bin identifiers into rack aisles, faces, bays, and levels. Numeric zone IDs determine left-to-right aisle-group order (Z001, Z002, Z003, and so on), with zone type used to order