function* promiseGenerator(promises) {
    for (const promise of promises) {
        yield promise;
    }
}

async function executePromisesSequentially(promises) {
    const generator = promiseGenerator(promises);

    let result = generator.next();
    while (!result.done) {
        // Wait for the current promise to resolve
        await result.value.then(console.log);
        // Move to the next promise
        result = generator.next();
    }
}

const promises = [
    new Promise(resolve => setTimeout(() => resolve('First promise'), 1000)),
    new Promise(resolve => setTimeout(() => resolve('Second promise'), 2000)),
    new Promise(resolve => setTimeout(() => resolve('Third promise'), 1500))
];

executePromisesSequentially(promises);
