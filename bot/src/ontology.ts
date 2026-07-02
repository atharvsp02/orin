// CodeGuard's decision ontology — grounds Cognee's extraction and models supersession in the graph,
// reinforcing the DB-side markSuperseded. Uploaded once per tenant; referenced by ONTOLOGY_KEY at ingest.
export const ONTOLOGY_KEY = "codeguard-decisions";
export const ONTOLOGY_FILENAME = "decision.owl";

export const DECISION_OWL = `<?xml version="1.0"?>
<rdf:RDF xmlns="http://codeguard.io/ontology/decision#"
     xml:base="http://codeguard.io/ontology/decision"
     xmlns:owl="http://www.w3.org/2002/07/owl#"
     xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
     xmlns:rdfs="http://www.w3.org/2000/01/rdf-schema#"
     xmlns:xsd="http://www.w3.org/2001/XMLSchema#">
  <owl:Ontology rdf:about="http://codeguard.io/ontology/decision"/>

  <owl:Class rdf:about="#Decision">
    <rdfs:comment>A maintainer decision recorded from an issue/PR thread.</rdfs:comment>
  </owl:Class>
  <owl:Class rdf:about="#Rejection">
    <rdfs:subClassOf rdf:resource="#Decision"/>
    <rdfs:comment>A decision whose outcome was to reject a proposal.</rdfs:comment>
  </owl:Class>
  <owl:Class rdf:about="#Rule">
    <rdfs:comment>A standing coding/contribution constraint.</rdfs:comment>
  </owl:Class>
  <owl:Class rdf:about="#Component">
    <rdfs:comment>A part of the codebase a decision applies to (dependency, path, tool).</rdfs:comment>
  </owl:Class>
  <owl:Class rdf:about="#Reviewer">
    <rdfs:comment>A maintainer who made or reviewed a decision.</rdfs:comment>
  </owl:Class>

  <owl:ObjectProperty rdf:about="#supersedes">
    <rdfs:domain rdf:resource="#Decision"/>
    <rdfs:range rdf:resource="#Decision"/>
  </owl:ObjectProperty>
  <owl:ObjectProperty rdf:about="#applies_to">
    <rdfs:domain rdf:resource="#Decision"/>
    <rdfs:range rdf:resource="#Component"/>
  </owl:ObjectProperty>
  <owl:ObjectProperty rdf:about="#rejected_because">
    <rdfs:domain rdf:resource="#Rejection"/>
  </owl:ObjectProperty>
  <owl:ObjectProperty rdf:about="#decided_by">
    <rdfs:domain rdf:resource="#Decision"/>
    <rdfs:range rdf:resource="#Reviewer"/>
  </owl:ObjectProperty>
</rdf:RDF>
`;
