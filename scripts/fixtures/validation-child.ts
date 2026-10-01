// Child behaviors for testing process supervision without shell evaluation.
switch (process.argv[2]) {
  case 'log': console.log(process.argv[3]); console.error('diagnostic'); break;
  case 'pass': break;
  case 'fail': process.exit(7); break;
  case 'hang': setInterval(() => {}, 1000); break;
  default: throw new Error(`Unknown validation fixture mode: ${process.argv[2]}`);
}
export {};
